// The two ways a batch stops before its last step: the aggregate response cap,
// and cancellation. Both have to be visible in the response and they have to
// stay apart, because the remedy differs. Truncated means "run the rest as a
// second batch"; cancelled means "the caller is gone, and whatever already ran
// stands".
//
// batch calls its peers through a handler map the registry injects, so fake
// peers are enough and no Arc is involved. Like batch.test.js, this file
// deliberately does not import ../src/registry.js: rebinding the lookup is a
// module-level side effect, and the registry is the only other caller.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { bindRegistry, handlers, tools } from '../src/tools/scripting.js';

const TAB = { id: 'A', title: 'A', url: 'https://a.test/', location: 'unpinned', mine: true };

// Each read tool caps itself at 20000 characters, so a result this size is a
// realistic single step rather than an invented extreme, and several of them
// overshoot the batch budget the way a real read-heavy sequence does.
const BIG_CHARS = 8000;

// The budget is module-private in scripting.js, but the batch description has to
// tell the model the number it is being held to, so that is where it is read
// from. A description that stops naming it fails the first test below.
const CAP = Number(tools.find((tool) => tool.name === 'batch').description.match(/capped at (\d+) characters/i)?.[1]);

const calls = [];
let controller = null;

const FAKE_HANDLERS = {
  fake_small: async () => {
    calls.push('fake_small');
    return { ok: true, text: 'short', tab: TAB };
  },
  fake_big: async () => {
    calls.push('fake_big');
    return { ok: true, text: 'x'.repeat(BIG_CHARS), tab: TAB };
  },
  // A step that cancels the caller partway through, which is what a client
  // sending notifications/cancelled looks like from inside the loop.
  fake_aborts: async () => {
    calls.push('fake_aborts');
    controller.abort();
    return { ok: true, text: 'ran before the cancel', tab: TAB };
  }
};

const steps = (tool, count) => Array.from({ length: count }, () => ({ tool }));

const runBatch = (args, extra) => {
  calls.length = 0;
  return handlers.batch(args, extra);
};

describe('the batch response cap', () => {
  before(() => {
    bindRegistry(() => FAKE_HANDLERS);
  });

  it('is stated in the description, so the model knows the budget before it packs a batch', () => {
    assert.ok(Number.isFinite(CAP) && CAP > 0, 'the batch description no longer names its character budget');
  });

  it('leaves a batch that fits well alone', async () => {
    const out = await runBatch({ steps: steps('fake_small', 3) });
    assert.equal(out.ran, 3);
    assert.equal(out.ok, true);
    assert.equal('truncated' in out, false, 'a small batch must not be flagged as truncated');
    assert.equal('note' in out, false, 'a small batch has nothing to steer the caller about');
  });

  it('stops a batch of large results early and says why', async () => {
    // Five 20000-character reads already overshoot what a client will accept,
    // and a clipped response is unreadable rather than short. So the batch stops
    // itself instead of letting the transport cut the JSON mid-object.
    const requested = 20;
    const out = await runBatch({ steps: steps('fake_big', requested) });

    assert.equal(out.truncated, true, 'a batch that hit the budget must say so');
    assert.equal(out.total, requested, 'the caller still sees how many steps it asked for');
    assert.ok(out.ran > 0, 'a truncated batch still has to run something');
    assert.ok(out.ran < requested, `all ${requested} steps ran, so the cap stopped nothing`);
    assert.equal(calls.length, out.ran, 'a step that was never run must not be reported as run');
  });

  it('steers the caller at the remaining steps rather than just failing', async () => {
    const out = await runBatch({ steps: steps('fake_big', 20) });
    assert.match(out.note, new RegExp(String(CAP)), 'the note does not say what the budget is');
    assert.match(out.note, /max_chars/, 'the note does not say how to make the reads smaller');
    assert.match(out.note, /second batch|remaining steps/, 'the note does not say the rest can be run separately');
  });

  it('keeps the response it hands back close to the budget', async () => {
    const out = await runBatch({ steps: steps('fake_big', 20) });
    const chars = JSON.stringify(out).length;

    // The step that spends the last of the budget is charged after it ran, so
    // its result is still reported: dropping it would hide a side effect the
    // caller has to know about. That is the whole overshoot.
    assert.ok(
      chars <= CAP + 2 * BIG_CHARS,
      `batch returned ${chars} characters against a ${CAP} character budget`
    );
    assert.ok(
      chars >= CAP / 2,
      `only ${chars} characters came back, so something other than the ${CAP} character cap stopped this batch`
    );
  });
});

describe('cancelling a batch', () => {
  before(() => {
    bindRegistry(() => FAKE_HANDLERS);
  });

  it('runs nothing at all when the signal is already aborted', async () => {
    // A cancelled caller is not going to read the results, and every remaining
    // step would spawn another osascript process against the user's Arc.
    const out = await runBatch({ steps: steps('fake_small', 3) }, { signal: AbortSignal.abort() });
    assert.equal(out.ran, 0);
    assert.equal(out.total, 3);
    assert.deepEqual(out.results, []);
    assert.deepEqual(calls, [], 'a pre-cancelled batch must not call a single peer');
    assert.match(out.note, /Cancelled after 0 of 3 steps/);
  });

  it('stops where it was when the signal aborts partway', async () => {
    controller = new AbortController();
    const out = await runBatch(
      { steps: [{ tool: 'fake_small' }, { tool: 'fake_aborts' }, { tool: 'fake_small' }, { tool: 'fake_small' }] },
      { signal: controller.signal }
    );
    assert.equal(out.ran, 2, 'the steps after the cancel must not run');
    assert.equal(out.total, 4);
    assert.deepEqual(calls, ['fake_small', 'fake_aborts']);
    assert.match(out.note, /Cancelled after 2 of 4 steps/);
    assert.match(out.note, /stands/, 'the note has to say the completed steps were not undone');
  });

  it('reports the steps that did run, so their side effects are not hidden', async () => {
    controller = new AbortController();
    const out = await runBatch(
      { steps: [{ tool: 'fake_small' }, { tool: 'fake_aborts' }, { tool: 'fake_small' }] },
      { signal: controller.signal }
    );
    assert.deepEqual(out.results.map((result) => result.tool), ['fake_small', 'fake_aborts']);
    for (const result of out.results) assert.equal(result.ok, true);
  });
});

describe('cancellation and truncation stay distinguishable', () => {
  before(() => {
    bindRegistry(() => FAKE_HANDLERS);
  });

  // Both stop the batch early and both explain themselves in note, so the only
  // machine-readable difference is the truncated flag. Collapsing the two would
  // send a caller off to run the remaining steps of a batch its user cancelled.
  it('a cancelled batch is never flagged truncated', async () => {
    const out = await runBatch({ steps: steps('fake_big', 20) }, { signal: AbortSignal.abort() });
    assert.equal('truncated' in out, false);
    assert.match(out.note, /Cancelled/);
  });

  it('a truncated batch never claims it was cancelled', async () => {
    const out = await runBatch({ steps: steps('fake_big', 20) });
    assert.equal(out.truncated, true);
    assert.doesNotMatch(out.note, /Cancel/i);
  });
});
