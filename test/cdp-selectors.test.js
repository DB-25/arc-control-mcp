// ref=, role=, label= and placeholder= in the DevTools tools. The ref table
// lives in Arc's isolated world, so the Apple Event side resolves the selector
// and stamps the element; the CDP side then selects the stamp. All fakes.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { HANDLERS } from '../src/registry.js';
import { deps } from '../src/cdp/run.js';
import { isSemantic, stampSelector, stampTarget, TARGET_ATTRIBUTE } from '../src/cdp/stamp.js';
import { ArcError } from '../src/jxa.js';

const envelope = (v) => ({ result: { value: { __arc: 1, ok: true, v } } });

/** A fake engine whose one tab answers Runtime.evaluate by looking at the expression. */
function harness({ dialog = null, answer = () => undefined } = {}) {
  const sent = [];
  const stamps = [];
  const tab = {
    capture: { dialog, dialogWaiter: () => ({ promise: new Promise(() => {}), dispose() {} }) },
    focusEmulation: true,
    session: {
      on: () => () => {},
      async send(method, params) {
        sent.push({ method, params });
        const custom = answer(method, params);
        if (custom !== undefined) return custom;
        if (method === 'Runtime.evaluate' && /getBoundingClientRect/.test(params.expression)) {
          return envelope({ matches: 1, target: { tag: 'button' }, disabled: false, x: 10, y: 20, rect: { x: 0, y: 0, width: 20, height: 40 }, scroll: { x: 0, y: 0 } });
        }
        return {};
      }
    }
  };
  deps.engine = {
    connection: async () => ({ send: async () => ({ targetInfo: { title: 'T', url: 'https://a.test/' } }) }),
    attach: async () => tab
  };
  deps.resolveTab = async () => ({ tabId: 'arc-1', targetId: 'target-1' });
  deps.stamp = async (tabId, spec) => {
    stamps.push({ tabId, ...spec });
    return { found: true, nonce: 'abc123', selector: stampSelector('abc123'), matches: 3, reResolved: true };
  };
  return { sent, stamps, tab };
}

describe('semantic selectors in the DevTools tools', () => {
  const original = { engine: deps.engine, resolveTab: deps.resolveTab, stamp: deps.stamp };
  afterEach(() => Object.assign(deps, original));

  it('isSemantic recognises the four prefixes and nothing else', () => {
    for (const s of ['ref=e12', 'role=button[name="Save"]', 'label=Email', 'placeholder=Search']) assert.equal(isSemantic(s), true, s);
    for (const s of ['#a', 'text=Save', 'input[ref=x]', 'a[href=b]', undefined, '']) assert.equal(isSemantic(s), false, String(s));
  });

  it('trusted_click on ref=e5 stamps the element, clicks by the stamp, reports the real count and reResolved, then clears it', async () => {
    const h = harness();
    const out = await HANDLERS.trusted_click({ selector: 'ref=e5', nth: 0 });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(h.stamps, [{ tabId: 'arc-1', selector: 'ref=e5', nth: 0, exact: false }]);
    const evaluations = h.sent.filter((c) => c.method === 'Runtime.evaluate').map((c) => c.params.expression);
    assert.ok(evaluations[0].includes(JSON.stringify(stampSelector('abc123'))), 'the lookup selects by the stamp');
    assert.ok(!evaluations[0].includes('ref=e5'), 'the CDP page script never sees the ref');
    assert.ok(h.sent.some((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed'));
    assert.match(evaluations.at(-1), /removeAttribute/, 'the stamp is removed afterwards');
    assert.equal(out.matches, 3);
    assert.equal(out.reResolved, true);
  });

  it('a CSS selector never goes through the stamp', async () => {
    const h = harness();
    await HANDLERS.trusted_click({ selector: '#go' });
    assert.equal(h.stamps.length, 0);
    assert.ok(!h.sent.some((c) => c.method === 'Runtime.evaluate' && /removeAttribute/.test(c.params.expression)));
  });

  it('fails with the selector the caller wrote when nothing matches it', async () => {
    harness();
    deps.stamp = async () => ({ found: false, matches: 0 });
    const out = await HANDLERS.trusted_hover({ selector: 'role=button[name="Nope"]' });
    assert.equal(out.ok, false);
    assert.match(out.error, /No element matches role=button\[name="Nope"\]/);
    assert.equal(out.matches, 0);
  });

  it('a stale ref surfaces the page\'s own message, as click does', async () => {
    harness();
    deps.stamp = async () => { throw new ArcError('The page script failed: Error: Ref e9 is stale: the button it pointed at is gone. Take a new snapshot to get current refs.'); };
    await assert.rejects(HANDLERS.trusted_click({ selector: 'ref=e9' }), /Ref e9 is stale/);
  });

  it('drag stamps both ends independently and keeps CSS and coordinate ends as they are', async () => {
    const h = harness();
    let n = 0;
    deps.stamp = async (tabId, spec) => {
      h.stamps.push(spec);
      const nonce = `n${++n}`;
      return { found: true, nonce, selector: stampSelector(nonce), matches: 1, reResolved: false };
    };
    h.tab.session.send = async (method, params) => {
      h.sent.push({ method, params });
      if (method === 'Runtime.evaluate' && /getBoundingClientRect/.test(params.expression)) {
        return envelope({ matches: 1, target: { tag: 'div' }, x: 5, y: 5, rect: { x: 0, y: 0, width: 10, height: 10 }, scroll: { x: 0, y: 0 } });
      }
      return {};
    };
    const out = await HANDLERS.drag({ from_selector: 'ref=e1', to_selector: 'label=Target', to_nth: 0, steps: 2 });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(h.stamps.map((s) => s.selector), ['ref=e1', 'label=Target']);
    const lookups = h.sent.filter((c) => c.method === 'Runtime.evaluate').map((c) => c.params.expression).join('\n');
    assert.ok(!lookups.includes('ref=e1') && !lookups.includes('label=Target'));
  });

  it('upload_file with a role selector looks the input up by the stamp and restores the caller\'s selector in errors', async () => {
    const h = harness({
      answer: (method, params) => {
        if (method === 'Runtime.evaluate' && /tagName/.test(params.expression)) return envelope({ matches: 1, tag: 'div', type: undefined, multiple: false, disabled: false });
        return undefined;
      }
    });
    const out = await HANDLERS.upload_file({ selector: 'role=button[name="Attach"]', paths: ['/etc/hosts'] });
    assert.equal(out.ok, false);
    assert.match(out.error, /role=button\[name="Attach"\] is a <div>, not an <input type=file>/);
    assert.ok(!out.error.includes(TARGET_ATTRIBUTE));
    assert.equal(h.stamps.length, 1);
  });

  it('screenshot of an element accepts a ref', async () => {
    const h = harness({ answer: (method) => (method === 'Page.captureScreenshot' ? { data: Buffer.from('x').toString('base64') } : undefined) });
    const out = await HANDLERS.screenshot({ selector: 'ref=e2' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.scope, 'element');
    assert.equal(h.stamps.length, 1);
  });

  it('while a dialog blocks the page the stamp cannot be cleared, and the result says so', async () => {
    const h = harness();
    // The dialog opens during the call, after the stamp was taken.
    h.tab.session.send = async (method, params) => {
      h.sent.push({ method, params });
      if (method === 'Runtime.evaluate' && /getBoundingClientRect/.test(params.expression)) {
        h.tab.capture.dialog = { type: 'alert', message: 'hi' };
        return envelope({ matches: 1, target: { tag: 'button' }, x: 1, y: 1, rect: { x: 0, y: 0, width: 2, height: 2 }, scroll: { x: 0, y: 0 } });
      }
      return {};
    };
    const out = await HANDLERS.trusted_hover({ selector: 'ref=e5' });
    assert.match(out.note, /data-arc-mcp-target/);
    assert.ok(!h.sent.some((c) => c.method === 'Runtime.evaluate' && /removeAttribute/.test(c.params.expression)));
  });
});

describe('stampTarget (the Apple Event side)', () => {
  const runWith = (result) => {
    const calls = [];
    return { calls, run: async (args, body) => { calls.push({ args, body }); return { result, tab: { id: 'arc-1' } }; } };
  };

  it('runs against the explicit tab id, resolves with the shared helpers and stamps the nth match', async () => {
    const { calls, run } = runWith({ matches: 2, reResolved: true });
    const out = await stampTarget('arc-1', { selector: 'ref=e4', nth: 1 }, { run, newNonce: () => 'nonce1' });
    assert.deepEqual(out, { found: true, nonce: 'nonce1', selector: '[data-arc-mcp-target="nonce1"]', matches: 2, reResolved: true });
    assert.equal(calls[0].args.tab_id, 'arc-1');
    assert.equal(calls[0].args.__allowActiveTab, true, 'an explicit id, so the Apple Event cannot drift');
    assert.match(calls[0].body, /A\.all\("ref=e4"/);
    assert.match(calls[0].body, /els\[1\]/);
    assert.match(calls[0].body, /setAttribute\("data-arc-mcp-target", "nonce1"\)/);
    assert.match(calls[0].body, /removeAttribute/, 'sweeps stamps an earlier call could not clear');
  });

  it('reports found false with the match count when nth is out of range', async () => {
    const { run } = runWith({ matches: 1 });
    assert.deepEqual(await stampTarget('arc-1', { selector: 'role=button', nth: 3 }, { run }), { found: false, matches: 1 });
    const none = runWith({ matches: 0 });
    assert.deepEqual(await stampTarget('arc-1', { selector: 'role=button' }, { run: none.run }), { found: false, matches: 0 });
  });
});
