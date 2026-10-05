// Integration tests for the interaction and observation tools. Like
// integration.test.js these drive the REAL Arc browser, so they are skipped
// unless ARC_MCP_INTEGRATION=1, open only tabs of their own from file://
// fixtures (plus a loopback server for the slow-page cases), pass an explicit
// tab_id on every call, and close what they open.
//
//   ARC_MCP_LABEL=arc-toolkit-it ARC_MCP_INTEGRATION=1 node --test test/integration-toolkit.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REASON = process.env.ARC_MCP_INTEGRATION !== '1'
  ? 'set ARC_MCP_INTEGRATION=1 to run the tests that drive Arc'
  : process.platform !== 'darwin'
    ? `Arc runs on macOS only, and this is ${process.platform}`
    : null;
const skip = REASON ?? false;

let fixtureDir = null;
if (!REASON) {
  fixtureDir = mkdtempSync(join(tmpdir(), 'arc-toolkit-'));
  process.env.ARC_MCP_STATE_DIR = join(fixtureDir, 'state');
  process.env.ARC_MCP_LABEL ||= 'arc-toolkit-it';
}

// The registry, not the bare modules: arguments go through the real validation
// and defaults, exactly as a client's call would.
const { HANDLERS: tool } = await import('../src/registry.js');

const FORM_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>toolkit form</title>
<style>#over{position:fixed;left:20px;top:200px;width:120px;height:40px;background:rgba(0,0,0,.2)}</style></head><body>
<div id="status">Working</div><div id="spin">Loading results</div><div id="scoped">Inside scope</div>
<input id="a"><input id="b"><input id="locked" disabled><input id="num" type="number">
<div id="menu" style="width:120px;height:30px;background:#ccc">Menu</div>
<button id="under" style="position:fixed;left:20px;top:200px;width:120px;height:40px">Under</button><div id="over"></div>
<input id="ac"><input id="blocked"><input id="short" maxlength="3"><input id="mask"><input id="pw" type="password">
<script>
var record = function (id, types) {
  var el = document.getElementById(id);
  types.forEach(function (t) {
    el.addEventListener(t, function (e) {
      var d = document.body.dataset;
      d[id] = (d[id] || '') + t + ':' + (e.data || e.key || '') + ' ';
    });
  });
};
record('ac', ['keydown', 'keypress', 'beforeinput', 'input', 'keyup']);
document.getElementById('blocked').addEventListener('keydown', function (e) { if (e.key === 'x') e.preventDefault(); });
document.getElementById('mask').addEventListener('input', function () { this.value = this.value.toUpperCase(); });
var seen = [];
['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'].forEach(function (t) {
  document.getElementById('menu').addEventListener(t, function () { seen.push(t); document.body.dataset.menu = seen.join(','); });
});
document.getElementById('under').addEventListener('mouseover', function () { document.body.dataset.under = '1'; });
setTimeout(function () {
  document.getElementById('status').textContent = 'All changes saved';
  document.getElementById('spin').remove();
}, 1500);
</script></body></html>`;

let formUrl = null;

async function withTab(url, body, { wait = true } = {}) {
  const opened = await tool.open_url({ url, activate: false, wait_until_loaded: wait });
  try {
    return await body(opened.tab.id, opened);
  } finally {
    await tool.close_tab({ tab_id: opened.tab.id });
  }
}

const dataset = async (tabId) =>
  JSON.parse((await tool.execute_javascript({ tab_id: tabId, code: 'JSON.stringify(document.body.dataset)' })).result);

describe('integration: interaction tools', () => {
  before(() => {
    if (REASON) return;
    const file = join(fixtureDir, 'form.html');
    writeFileSync(file, FORM_PAGE);
    formUrl = pathToFileURL(file).href;
  });

  after(async () => {
    if (REASON) return;
    await tool.close_own_tabs({});
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('wait_for_text sees text appear, and a spinner label disappear', { skip }, async () => {
    await withTab(formUrl, async (tabId) => {
      const appeared = await tool.wait_for_text({ tab_id: tabId, texts: ['no such text', 'all changes SAVED'], timeout_ms: 8000 });
      assert.equal(appeared.ok, true, appeared.note);
      assert.equal(appeared.matched, 'all changes SAVED');
      assert.match(appeared.context, /All changes saved/);

      const gone = await tool.wait_for_text({ tab_id: tabId, texts: ['Loading results'], state: 'absent', timeout_ms: 8000 });
      assert.equal(gone.ok, true, gone.note);

      const regex = await tool.wait_for_text({ tab_id: tabId, regex: 'all\\s+changes', timeout_ms: 3000 });
      assert.equal(regex.ok, true);
      assert.match(regex.matched, /^\/all/);
    });
  });

  it('wait_for_text times out honestly, and scopes to a selector', { skip }, async () => {
    await withTab(formUrl, async (tabId) => {
      const started = Date.now();
      const missing = await tool.wait_for_text({ tab_id: tabId, texts: ['never on this page'], timeout_ms: 1500 });
      assert.equal(missing.ok, false);
      assert.equal(missing.timedOut, true);
      assert.ok(missing.waitedMs >= 1400 && Date.now() - started < 8000);

      // The text exists on the page but not inside the scope.
      const scoped = await tool.wait_for_text({ tab_id: tabId, texts: ['Working'], selector: '#scoped', timeout_ms: 1200 });
      assert.equal(scoped.ok, false);
      assert.equal(scoped.scopeMatches, 1);
      const inScope = await tool.wait_for_text({ tab_id: tabId, texts: ['inside scope'], selector: '#scoped', timeout_ms: 3000 });
      assert.equal(inScope.ok, true);

      const noScope = await tool.wait_for_text({ tab_id: tabId, texts: ['x'], selector: '#nowhere', state: 'absent', timeout_ms: 3000 });
      assert.equal(noScope.ok, true);
      assert.match(noScope.note, /no text to find/);
    });
  });

  it('wait_for_text stops at the next poll when cancelled', { skip }, async () => {
    await withTab(formUrl, async (tabId) => {
      const controller = new AbortController();
      const started = Date.now();
      const waiting = tool.wait_for_text({ tab_id: tabId, texts: ['never'], timeout_ms: 30000 }, { signal: controller.signal });
      controller.abort();
      await assert.rejects(() => waiting, /Cancelled/);
      assert.ok(Date.now() - started < 15000);
    });
  });

  it('fill_form fills what it can, reports each field, and names the ones that failed', { skip }, async () => {
    await withTab(formUrl, async (tabId) => {
      const result = await tool.fill_form({
        tab_id: tabId,
        fields: [
          { selector: '#a', value: 'one' },
          { selector: '#locked', value: 'x' },
          { selector: '#num', value: 'abc' },
          { selector: '#nowhere', value: 'z' },
          { selector: '#b', value: 'two' }
        ]
      });
      assert.equal(result.ok, false);
      assert.equal(result.filled, 2);
      assert.equal(result.failed, 3);
      assert.deepEqual(result.fields.map((f) => f.ok), [true, false, false, false, true]);
      assert.match(result.error, /#locked/);
      assert.match(result.error, /#num/);
      assert.match(result.error, /#nowhere/);
      assert.ok(!JSON.stringify(result.fields).includes('"one"'), 'values are not echoed');

      // What the tool says and what the page holds have to agree.
      const held = await tool.execute_javascript({ tab_id: tabId, code: "[a.value, b.value, num.value, locked.value].join('|')" });
      assert.equal(held.result, 'one|two||');

      const clean = await tool.fill_form({ tab_id: tabId, fields: [{ selector: '#a', value: '1' }, { selector: '#b', value: '2' }] });
      assert.equal(clean.ok, true);
    });
  });

  it('hover fires the six pointer and mouse events, and reports what covers the target', { skip }, async () => {
    await withTab(formUrl, async (tabId) => {
      const hovered = await tool.hover({ tab_id: tabId, selector: '#menu' });
      assert.equal(hovered.ok, true);
      assert.equal(hovered.coveredBy, undefined);
      const events = (await dataset(tabId)).menu;
      assert.equal(events, 'pointerover,pointerenter,mouseover,mouseenter,pointermove,mousemove');

      const covered = await tool.hover({ tab_id: tabId, selector: '#under' });
      assert.equal(covered.ok, true);
      assert.equal(covered.coveredBy, '<div#over>');
      assert.match(covered.warning, /sits on top/);

      const miss = await tool.hover({ tab_id: tabId, selector: '#nowhere' });
      assert.equal(miss.ok, false);
    });
  });

  it('type sends the full key sequence per character and appends with the native setter', { skip }, async () => {
    await withTab(formUrl, async (tabId) => {
      const typed = await tool.type({ tab_id: tabId, selector: '#ac', text: 'abc' });
      assert.equal(typed.ok, true, typed.error);
      assert.equal(typed.value, 'abc');
      assert.equal(typed.inserted, 3);
      assert.equal(
        (await dataset(tabId)).ac.trim().split(' ').slice(0, 5).join(' '),
        'keydown:a keypress:a beforeinput:a input:a keyup:a'
      );
      assert.equal((await dataset(tabId)).ac.trim().split(' ').length, 15, 'five events for each of three characters');

      // Appends by default, replaces with clear.
      const more = await tool.type({ tab_id: tabId, selector: '#ac', text: 'd' });
      assert.equal(more.value, 'abcd');
      const cleared = await tool.type({ tab_id: tabId, selector: '#ac', text: 'z', clear: true });
      assert.equal(cleared.value, 'z');
    });
  });

  it('type does not report success for characters that never went in', { skip }, async () => {
    await withTab(formUrl, async (tabId) => {
      const blocked = await tool.type({ tab_id: tabId, selector: '#blocked', text: 'axb' });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.inserted, 2);
      assert.equal(blocked.value, 'ab');
      assert.match(blocked.error, /2 of 3/);

      const short = await tool.type({ tab_id: tabId, selector: '#short', text: 'abcdef' });
      assert.equal(short.ok, false);
      assert.equal(short.value, 'abc');
      assert.match(short.error, /maxlength/);

      const number = await tool.type({ tab_id: tabId, selector: '#num', text: '12' });
      assert.equal(number.ok, false);
      assert.match(number.error, /Use fill/);

      await assert.rejects(() => tool.type({ tab_id: tabId, selector: '#locked', text: 'x' }), /disabled/);
    });
  });

  it('type reports a page that rewrites the value, and never echoes a password', { skip }, async () => {
    await withTab(formUrl, async (tabId) => {
      const masked = await tool.type({ tab_id: tabId, selector: '#mask', text: 'abc' });
      assert.equal(masked.ok, true);
      assert.equal(masked.valueMatches, false);
      assert.equal(masked.value, 'ABC');
      assert.match(masked.note, /rewrote/);

      const secret = await tool.type({ tab_id: tabId, selector: '#pw', text: 'hunter2' });
      assert.equal(secret.ok, true);
      assert.equal(secret.length, 7);
      assert.ok(!JSON.stringify(secret).includes('hunter2'), 'a password must not come back in the response');
    });
  });

  it('type with delay_ms runs on page timers and reports what it finished', { skip }, async () => {
    await withTab(formUrl, async (tabId) => {
      const typed = await tool.type({ tab_id: tabId, selector: '#ac', text: 'xyz', delay_ms: 40 });
      // A background tab may throttle the page's timers. Either it finished, or
      // it said plainly that it did not: a success it did not earn is the failure.
      if (typed.ok) assert.equal(typed.value, 'xyz');
      else assert.match(typed.error, /Stopped after \d+ of 3 characters/);
    });
  });
});

// A loopback server with one endpoint that never answers and one that answers
// late, so "still loading" is a real state Arc is in rather than a mock.
const SLOW_MS = 3000;
let server = null;
let origin = null;

describe('integration: loading state', () => {
  before(async () => {
    if (REASON) return;
    server = createServer((req, res) => {
      if (req.url.startsWith('/hang')) return; // never answers
      if (req.url.startsWith('/slow')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        setTimeout(() => res.end('<!doctype html><title>slow page</title><p>arrived</p>'), SLOW_MS);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const frame = join(fixtureDir, 'frame.html');
    writeFileSync(frame, `<!doctype html><title>frame host</title><p>host</p><iframe src="${origin}/hang"></iframe>`);
    frameUrl = pathToFileURL(frame).href;
  });

  after(async () => {
    if (REASON) return;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await tool.close_own_tabs({});
  });

  let frameUrl = null;

  it('wait_for_load reports a page that is still loading, and stop_loading unblocks it', { skip }, async () => {
    // wait_until_loaded false: this call must not itself sit waiting on the hung frame.
    await withTab(frameUrl, async (tabId) => {
      const stuck = await tool.wait_for_load({ tab_id: tabId, timeout_ms: 3000 });
      assert.equal(stuck.ok, false);
      assert.equal(stuck.timedOut, true);
      assert.equal(stuck.ready, 'loading', 'the loading flag, not a stalled probe, explains the timeout');
      assert.match(stuck.note, /stop_loading/);
      assert.ok(stuck.waitedMs < 8000, `the wait took ${stuck.waitedMs}ms, so it stalled instead of polling`);

      const stopped = await tool.stop_loading({ tab_id: tabId });
      assert.equal(stopped.ok, true, stopped.error);
      assert.equal(stopped.wasLoading, true);
      assert.equal(stopped.loading, false);

      // The page answers again, and what had rendered is still there.
      const ready = await tool.wait_for_load({ tab_id: tabId, timeout_ms: 5000 });
      assert.equal(ready.ok, true);
      assert.equal(ready.ready, 'complete');
      const text = await tool.get_page_content({ tab_id: tabId });
      assert.match(text.text, /host/);
    }, { wait: false });
  });

  it('stop_loading on a tab that is not loading says so and succeeds', { skip }, async () => {
    await withTab(formUrl, async (tabId) => {
      const result = await tool.stop_loading({ tab_id: tabId });
      assert.equal(result.ok, true);
      assert.equal(result.wasLoading, false);
      assert.match(result.note, /nothing to stop/);
    });
  });

  it('wait_for_load waits out a genuinely slow page and then reports it complete', { skip }, async () => {
    await withTab(`${origin}/slow`, async (tabId) => {
      const started = Date.now();
      const ready = await tool.wait_for_load({ tab_id: tabId, timeout_ms: 15000 });
      assert.equal(ready.ok, true, ready.note);
      assert.equal(ready.ready, 'complete');
      assert.ok(Date.now() - started < 12000);
      const text = await tool.get_page_content({ tab_id: tabId });
      assert.match(text.text, /arrived/);
    }, { wait: false });
  });
});
