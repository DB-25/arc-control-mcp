// Unit checks for snapshots, refs and the settle wait: everything that does
// not need a real DOM. The tree walk and ref re-resolution are covered against
// real Arc in integration.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { PAGE_LIB, pageScript } from '../src/page-lib.js';
import { SNAPSHOT_LIB } from '../src/page-snapshot.js';
import { SEMANTIC_LIB } from '../src/page-semantic.js';
import { TOOLS, HANDLERS } from '../src/registry.js';
import { quietMs, watchStart } from '../src/tools/settle.js';
import { ArcError } from '../src/jxa.js';

const parses = (source) => {
  try {
    new vm.Script(source);
    return null;
  } catch (error) {
    return error.message;
  }
};

const tool = (name) => TOOLS.find((t) => t.name === name);
const props = (name) => tool(name).inputSchema.properties;

describe('the snapshot helpers', () => {
  it('parse as JavaScript, on their own and appended to the page library', () => {
    assert.equal(parses(SEMANTIC_LIB), null);
    assert.equal(parses(SNAPSHOT_LIB), null);
    assert.equal(parses(PAGE_LIB + SNAPSHOT_LIB), null);
  });

  it('load in a bare context without touching the DOM, and define snapshot and semantic', () => {
    const context = vm.createContext({});
    vm.runInContext(`${PAGE_LIB}${SNAPSHOT_LIB}`, context);
    assert.equal(vm.runInContext('typeof A.snapshot', context), 'function');
    assert.equal(vm.runInContext('typeof A.semantic', context), 'function');
  });

  it('ship with a script only when it mentions a semantic selector or the snapshot', () => {
    for (const body of ['return A.all("ref=e3");', 'return A.all("role=button");', 'return A.all("label=Email");', 'return A.all("placeholder=Q");', 'return A.snapshot({});']) {
      assert.ok(pageScript(body).includes('api.snapshot = '), `should include the helpers for ${body}`);
      assert.equal(parses(pageScript(body)), null);
    }
    for (const body of ['return 1;', 'return A.all("text=Save").length;', 'return document.title;']) {
      assert.ok(!pageScript(body).includes('api.snapshot = '), `should leave the helpers out for ${body}`);
    }
  });

  it('A.all refuses a semantic selector with a clear error when the helpers are not loaded', () => {
    const context = vm.createContext({ document: {} });
    vm.runInContext(PAGE_LIB, context);
    assert.throws(() => vm.runInContext('A.all("ref=e1")', context), /needs the semantic helpers/);
    // Writing a literal cannot help a DevTools script, so the error must not suggest it.
    assert.throws(() => vm.runInContext('A.all("ref=e1")', context), (e) => !/as a literal/.test(e.message));
  });
});

describe('the DOM watcher behind settledMs', () => {
  // A fake observer and clock, so the quiet-window logic is exercised without
  // a browser: records are queued by the test and delivered by takeRecords.
  function page() {
    const clock = { t: 1000 };
    const queue = [];
    const context = vm.createContext({
      window: { performance: { now: () => clock.t } },
      document: { hidden: false },
      Object,
      Math,
      MutationObserver: class {
        constructor(callback) { this.callback = callback; }
        observe() {}
        disconnect() { this.stopped = true; }
        takeRecords() { return queue.splice(0); }
      }
    });
    vm.runInContext(PAGE_LIB, context);
    return {
      clock,
      queue,
      run: (code) => JSON.parse(JSON.stringify(vm.runInContext(code, context)))
    };
  }

  it('reports done once the page has been quiet for the window, with no mutations seen', () => {
    const p = page();
    const id = p.run('A.watch()');
    p.clock.t += 100;
    assert.deepEqual(p.run(`A.settleStatus(${JSON.stringify(id)}, 300)`), { done: false, quietFor: 100, settledMs: 0, mutations: 0, hidden: false });
    p.clock.t += 250;
    const out = p.run(`A.settleStatus(${JSON.stringify(id)}, 300)`);
    assert.equal(out.done, true);
    assert.equal(out.settledMs, 0);
  });

  it('counts a pending mutation as activity and restarts the quiet window from it', () => {
    const p = page();
    const id = p.run('A.watch()');
    p.clock.t += 400;
    p.queue.push({}, {});
    const out = p.run(`A.settleStatus(${JSON.stringify(id)}, 300)`);
    assert.equal(out.done, false, 'the window restarts at the mutation, however long ago the action was');
    assert.equal(out.mutations, 2);
    assert.equal(out.settledMs, 400);
    p.clock.t += 300;
    assert.equal(p.run(`A.settleStatus(${JSON.stringify(id)}, 300)`).done, true);
  });

  it('reports lost for a watch that does not belong to this page, as after a navigation', () => {
    const p = page();
    p.run('A.watch()');
    assert.deepEqual(p.run('A.settleStatus("some-other-id", 300)'), { lost: true });
  });
});

describe('the settle parameter', () => {
  it('is advertised on every tool that changes the page, and on no read tool', () => {
    for (const name of ['click', 'fill', 'select_option', 'press_key']) {
      const p = props(name).settle_ms;
      assert.ok(p, `${name} needs settle_ms`);
      assert.equal(p.default, 300);
      assert.equal(p.maximum, 1500);
      assert.equal(p.minimum, 0);
    }
    for (const name of ['snapshot', 'scroll', 'wait_for_selector', 'get_page_content']) {
      assert.equal(props(name).settle_ms, undefined, `${name} does not mutate, so it has nothing to settle`);
    }
  });

  it('turns into a quiet window of 300ms by default, honours 0, and never exceeds the cap', () => {
    assert.equal(quietMs({}), 300);
    assert.equal(quietMs({ settle_ms: 0 }), 0);
    assert.equal(quietMs({ settle_ms: 9999 }), 1500);
    assert.match(watchStart({ settle_ms: 0 }), /= null;/);
    assert.match(watchStart({}), /A\.watch\(\)/);
  });
});

describe('the snapshot tool definition', () => {
  it('is read-only and idempotent, so it may read a tab without owning it', () => {
    const a = tool('snapshot').annotations;
    assert.equal(a.readOnlyHint, true);
    assert.equal(a.destructiveHint, false);
    assert.equal(a.idempotentHint, true);
  });

  it('takes the documented options with the documented defaults', () => {
    const p = props('snapshot');
    assert.deepEqual(Object.keys(p).sort(), ['boxes', 'depth', 'diff', 'interactive_only', 'max_chars', 'scope', 'tab_id']);
    assert.equal(p.interactive_only.default, false);
    assert.equal(p.boxes.default, false);
    assert.equal(p.diff.default, false);
    assert.equal(p.max_chars.default, 20000);
    assert.deepEqual(tool('snapshot').inputSchema.required ?? [], []);
  });

  it('rejects a negative depth before anything reaches Arc', async () => {
    await assert.rejects(() => HANDLERS.snapshot({ depth: -1 }), (error) => error instanceof ArcError && /depth/.test(error.message));
  });

  it('is described well enough for a model to use refs from it', () => {
    const text = tool('snapshot').description;
    for (const word of ['ref=e12', 'interactive_only', 'diff', 'snapshot again']) assert.ok(text.includes(word), `description should mention ${word}`);
  });
});

describe('the selector description', () => {
  it('names every form a selector accepts, on every tool that takes one', () => {
    for (const name of ['click', 'fill', 'press_key', 'scroll', 'query_elements', 'wait_for_selector', 'get_page_content', 'get_html']) {
      const text = props(name).selector.description;
      for (const form of ['text=', 'ref=', 'role=', 'label=', 'placeholder=']) assert.ok(text.includes(form), `${name}'s selector should mention ${form}`);
    }
  });
});
