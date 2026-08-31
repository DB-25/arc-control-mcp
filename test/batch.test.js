// `batch` is where the silent-failure bug was actually noticed: four steps in
// which nothing happened reported ok on every one. It calls its peers through a
// handler map the registry injects, so fake peers are enough to test it and no
// Arc is involved.
//
// This file deliberately does not import ../src/registry.js. Rebinding the
// lookup is a module-level side effect, and the registry is the only other
// thing that ever calls bindRegistry.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { bindRegistry, handlers } from '../src/tools/scripting.js';
import { ArcError } from '../src/jxa.js';

const TAB_A = { id: 'A', title: 'A', url: 'https://a.test/', location: 'unpinned', mine: true };
const TAB_B = { id: 'B', title: 'B', url: 'https://b.test/', location: 'unpinned', mine: true };
// Same tab, later in its life: the title flapped but the id and url did not, so
// batch has to treat this as the same tab rather than a second one.
const TAB_A_RETITLED = { ...TAB_A, title: 'A (2)' };

const calls = [];

// Peers shaped like the real handlers: a plain object on success, a thrown
// ArcError for a page or Arc failure, `ok: false` for a soft miss.
const FAKE_HANDLERS = {
  fake_ok: async (args) => {
    calls.push(['fake_ok', args]);
    return { ok: true, value: 'fine', tab: TAB_A };
  },
  fake_ok_later: async (args) => {
    calls.push(['fake_ok_later', args]);
    return { ok: true, value: 'fine', tab: TAB_A_RETITLED };
  },
  fake_other_tab: async (args) => {
    calls.push(['fake_other_tab', args]);
    return { ok: true, value: 'elsewhere', tab: TAB_B };
  },
  fake_throws: async (args) => {
    calls.push(['fake_throws', args]);
    throw new ArcError('The page script failed: Error: boom');
  },
  fake_soft_miss: async (args) => {
    calls.push(['fake_soft_miss', args]);
    return { ok: false, error: 'No element matches #nope', tab: TAB_A };
  },
  fake_no_tab: async (args) => {
    calls.push(['fake_no_tab', args]);
    return { ok: true, closed: 0 };
  }
};

const step = (tool, args) => (args ? { tool, args } : { tool });
const runBatch = (args) => {
  calls.length = 0;
  return handlers.batch(args);
};

describe('batch', () => {
  before(() => {
    bindRegistry(() => FAKE_HANDLERS);
  });

  it('reports a failure on every failing step, never four cheerful successes', async () => {
    // The reported symptom, from the outside: nothing happened, and the old
    // code said ok four times.
    const out = await runBatch({ steps: Array(4).fill(step('fake_throws')), continue_on_error: true });
    assert.equal(out.ok, false);
    assert.equal(out.ran, 4);
    assert.equal(out.total, 4);
    for (const result of out.results) {
      assert.equal(result.ok, false);
      assert.match(result.error, /boom/);
    }
  });

  it('stops at the first failing step by default and says how many it ran', async () => {
    const out = await runBatch({ steps: [step('fake_ok'), step('fake_throws'), step('fake_ok')] });
    assert.equal(out.ok, false);
    assert.equal(out.ran, 2, 'the third step must not run');
    assert.equal(out.total, 3, 'the caller still sees how many it asked for');
    assert.deepEqual(calls.map(([name]) => name), ['fake_ok', 'fake_throws']);
  });

  it('keeps going after a failure when continue_on_error is set', async () => {
    const out = await runBatch({
      steps: [step('fake_throws'), step('fake_ok'), step('fake_throws')],
      continue_on_error: true
    });
    assert.equal(out.ran, 3);
    assert.equal(out.ok, false, 'one bad step still fails the batch');
    assert.deepEqual(out.results.map((r) => r.ok), [false, true, false]);
  });

  it('treats a step that returns ok false as a failure, not just a thrown one', async () => {
    // A soft miss (no element matched) reports ok: false rather than throwing.
    const out = await runBatch({ steps: [step('fake_soft_miss'), step('fake_ok')] });
    assert.equal(out.ok, false);
    assert.equal(out.ran, 1);
    assert.equal(out.results[0].ok, false);
    assert.match(out.results[0].result.error, /No element matches/);
  });

  it('reports an unknown tool as a failing step instead of skipping it quietly', async () => {
    const out = await runBatch({ steps: [step('no_such_tool'), step('fake_ok')] });
    assert.equal(out.ok, false);
    assert.equal(out.ran, 1);
    assert.equal(out.results[0].tool, 'no_such_tool');
    assert.match(out.results[0].error, /Unknown tool: no_such_tool/);
    assert.deepEqual(calls, [], 'nothing should have been called');
  });

  it('reports ok true only when every step succeeded', async () => {
    const out = await runBatch({ steps: [step('fake_ok'), step('fake_ok')] });
    assert.equal(out.ok, true);
    assert.equal(out.ran, 2);
    assert.deepEqual(out.results.map((r) => r.index), [0, 1]);
    assert.deepEqual(out.results.map((r) => r.tool), ['fake_ok', 'fake_ok']);
  });

  it('reports an empty step list without inventing work', async () => {
    const out = await runBatch({ steps: [] });
    assert.equal(out.ran, 0);
    assert.equal(out.total, 0);
    assert.equal(out.ok, true);
    assert.deepEqual(out.results, []);
  });

  it('passes the batch tab_id to steps that do not set their own', async () => {
    await runBatch({ tab_id: 'BATCH-TAB', steps: [step('fake_ok'), step('fake_ok', { selector: 'h1' })] });
    assert.deepEqual(calls[0][1], { tab_id: 'BATCH-TAB' });
    assert.deepEqual(calls[1][1], { tab_id: 'BATCH-TAB', selector: 'h1' });
  });

  it('lets a step override the batch tab_id', async () => {
    await runBatch({ tab_id: 'BATCH-TAB', steps: [step('fake_ok', { tab_id: 'STEP-TAB' })] });
    assert.deepEqual(calls[0][1], { tab_id: 'STEP-TAB' });
  });

  it('hoists the shared tab out of the steps rather than repeating it in each', async () => {
    // Repeating the tab (url and all) once per step buried the actual results.
    const out = await runBatch({ steps: [step('fake_ok'), step('fake_ok'), step('fake_ok')] });
    assert.deepEqual(out.tab, TAB_A);
    for (const result of out.results) {
      assert.equal('tab' in result, false, 'a step on the common tab must not repeat it');
      assert.equal('tab' in result.result, false, 'nor may the nested step value');
      assert.equal(result.result.value, 'fine', 'the rest of the step value survives');
    }
  });

  it('flags only the step whose tab really differs', async () => {
    const out = await runBatch({ steps: [step('fake_ok'), step('fake_other_tab'), step('fake_ok')] });
    assert.deepEqual(out.tab, TAB_A, 'the tab most steps saw');
    assert.equal('tab' in out.results[0], false);
    assert.deepEqual(out.results[1].tab, TAB_B);
    assert.equal('tab' in out.results[2], false);
  });

  it('treats a retitled tab as the same tab, since a single-page app retitles freely', async () => {
    const out = await runBatch({ steps: [step('fake_ok'), step('fake_ok_later')] });
    // Same id and url, so no step is flagged as being on a different tab.
    for (const result of out.results) assert.equal('tab' in result, false);
    assert.equal(out.tab.id, 'A');
  });

  it('omits the batch tab when no step reported one', async () => {
    const out = await runBatch({ steps: [step('fake_no_tab')] });
    assert.equal('tab' in out, false);
    assert.equal(out.ok, true);
  });
});
