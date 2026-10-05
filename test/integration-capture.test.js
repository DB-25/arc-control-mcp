// Integration tests for console and network observation, against real Arc.
// Skipped unless ARC_MCP_INTEGRATION=1. They open only their own tabs, from
// file:// fixtures and a loopback server, and close them.
//
//   ARC_MCP_LABEL=arc-toolkit-it ARC_MCP_INTEGRATION=1 node --test test/integration-capture.test.js
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
  fixtureDir = mkdtempSync(join(tmpdir(), 'arc-capture-'));
  process.env.ARC_MCP_STATE_DIR = join(fixtureDir, 'state');
  process.env.ARC_MCP_LABEL ||= 'arc-toolkit-it';
}

const { HANDLERS: tool } = await import('../src/registry.js');

// Every call here is made by the page's own scripts, in its own JavaScript
// world, which is the point: the server's scripts run in an isolated world and
// would see none of it without the injected recorder.
const CAPTURE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>capture page</title></head><body>
<button id="go" onclick="
  console.log('hello from page', 42);
  console.error('page error line');
  fetch('data:text/plain,hi').then(function (r) { return r.text(); });
  fetch('file:///arc-capture-nonexistent').catch(function () {});
  var x = new XMLHttpRequest(); x.open('GET', 'data:text/plain,x'); x.send();
  setTimeout(function () { throw new Error('late boom'); }, 0);
  Promise.reject(new Error('rejected on purpose'));
">go</button></body></html>`;

// script-src 'none' is what a locked-down site sends: inline script cannot run,
// so the recorder cannot be injected.
const CSP_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'"><title>csp page</title></head><body>locked down</body></html>`;

let server = null;
let origin = null;
const urls = {};

async function withTab(url, body) {
  const opened = await tool.open_url({ url, activate: false });
  try {
    return await body(opened.tab.id);
  } finally {
    await tool.close_tab({ tab_id: opened.tab.id });
  }
}

async function readUntil(tabId, wanted, args = {}) {
  let last = null;
  for (let i = 0; i < 12; i++) {
    last = await tool.capture_read({ tab_id: tabId, ...args });
    if (last.ok && wanted(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return last;
}

describe('integration: console and network capture', () => {
  before(async () => {
    if (REASON) return;
    writeFileSync(join(fixtureDir, 'capture.html'), CAPTURE_PAGE);
    writeFileSync(join(fixtureDir, 'csp.html'), CSP_PAGE);
    urls.capture = pathToFileURL(join(fixtureDir, 'capture.html')).href;
    urls.csp = pathToFileURL(join(fixtureDir, 'csp.html')).href;
    server = createServer((req, res) => {
      if (req.url.startsWith('/res.json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } else if (req.url.startsWith('/page')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end("<!doctype html><title>net page</title><script>fetch('/res.json?token=SECRET').then(function(r){return r.text()})</script>");
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (REASON) return;
    await new Promise((resolve) => server.close(resolve));
    await tool.close_own_tabs({});
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('captures what the page itself logs, fetches and throws, which an isolated-world wrapper would miss', { skip }, async () => {
    await withTab(urls.capture, async (tabId) => {
      const early = await tool.capture_read({ tab_id: tabId });
      assert.equal(early.ok, false, 'reading before starting must not look like a quiet page');
      assert.equal(early.installed, false);

      const started = await tool.capture_start({ tab_id: tabId });
      assert.equal(started.ok, true, started.error);
      const again = await tool.capture_start({ tab_id: tabId });
      assert.equal(again.alreadyInstalled, true, 'a second start must not wrap everything twice');

      await tool.click({ tab_id: tabId, selector: '#go' });
      const read = await readUntil(tabId, (r) => ['console', 'fetch', 'xhr', 'error', 'unhandledrejection']
        .every((type) => r.events.some((e) => e.type === type)));
      assert.equal(read.ok, true);
      const byType = (type) => read.events.filter((e) => e.type === type);

      assert.ok(byType('console').some((e) => e.level === 'log' && e.text === 'hello from page 42'));
      assert.ok(byType('console').some((e) => e.level === 'error' && e.text === 'page error line'));
      const dataFetch = byType('fetch').find((e) => e.status === 200);
      assert.ok(dataFetch, 'the fetch to a data: url is recorded with its status');
      assert.equal(dataFetch.method, 'GET');
      assert.ok(!dataFetch.url.includes('hi'), 'a data: url is reduced to its scheme');
      assert.ok(byType('fetch').some((e) => e.error), 'the failed fetch is recorded as an error');
      assert.equal(byType('xhr').length, 1);
      assert.match(byType('error')[0].message, /late boom/);
      assert.match(byType('unhandledrejection')[0].reason, /rejected on purpose/);
      for (const event of read.events) {
        assert.ok(!('body' in event) && !('headers' in event), 'no bodies or headers, ever');
      }

      // kind narrows, and clear removes only what was returned.
      const consoleOnly = await tool.capture_read({ tab_id: tabId, kind: 'console', clear: true });
      assert.ok(consoleOnly.events.length >= 2);
      assert.ok(consoleOnly.events.every((e) => e.type === 'console'));
      const rest = await tool.capture_read({ tab_id: tabId });
      assert.ok(rest.events.every((e) => e.type !== 'console'), 'cleared console events are gone');
      assert.ok(rest.events.length > 0, 'clear left the other kinds alone');
    });
  });

  it('says plainly that capture is blocked when the page CSP forbids the injected script', { skip }, async () => {
    await withTab(urls.csp, async (tabId) => {
      const started = await tool.capture_start({ tab_id: tabId });
      assert.equal(started.ok, false);
      assert.equal(started.installed, false);
      assert.match(started.error, /Content-Security-Policy/);
      assert.match(started.cspMeta, /script-src 'none'/);
      assert.match(started.error, /network_entries/);

      const read = await tool.capture_read({ tab_id: tabId });
      assert.equal(read.ok, false, 'a blocked capture must not read back as an empty, successful one');

      const entries = await tool.network_entries({ tab_id: tabId });
      assert.equal(entries.ok, true, 'resource timing needs no injection, so it still works');
    });
  });

  it('network_entries lists requests from resource timing without a recorder, and drops the query', { skip }, async () => {
    await withTab(`${origin}/page`, async (tabId) => {
      let result = null;
      for (let i = 0; i < 10; i++) {
        result = await tool.network_entries({ tab_id: tabId, filter: 'res.json' });
        if (result.entries.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      assert.equal(result.ok, true);
      assert.equal(result.entries.length, 1);
      const [entry] = result.entries;
      assert.equal(entry.url, `${origin}/res.json`);
      assert.equal(entry.initiator, 'fetch');
      assert.equal(entry.status, 200);
      assert.ok(!JSON.stringify(result).includes('SECRET'), 'the query string must not come back');

      const withQuery = await tool.network_entries({ tab_id: tabId, filter: 'res.json', include_query: true });
      assert.match(withQuery.entries[0].url, /token=SECRET/);

      const later = await tool.network_entries({ tab_id: tabId, since_ms: result.nowMs + 1 });
      assert.equal(later.entries.length, 0, 'since_ms excludes what already happened');
    });
  });
});
