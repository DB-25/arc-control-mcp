// The CDP engine against a real browser: Chrome for Testing, never Arc. Gated
// because it launches a browser (a window, unless headless works for the case):
//   ARC_MCP_CDP_IT=1 node --test test/cdp-integration.test.js
//
// Arc's own tab resolution (Apple Events) is the one thing replaced: tab ids
// here are made up, and "marking" a tab writes the nonce through a separate
// DevTools connection instead of JXA. Everything from the mapper down is the
// code that ships.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const ENABLED = process.env.ARC_MCP_CDP_IT === '1';
const CHROME = process.env.ARC_MCP_CHROME ||
  `${homedir()}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const HEADLESS = process.env.ARC_MCP_CDP_IT_HEADFUL !== '1';

const PAGE = `<!doctype html><html><head><title>Fixture</title><style>
  body { margin: 0; font: 16px sans-serif; background: linear-gradient(90deg, #fde68a, #93c5fd); min-height: 1600px; }
  #red { width: 200px; height: 100px; background: rgb(220, 20, 20); margin: 10px; }
  #slider { width: 300px; height: 20px; background: #666; position: relative; margin: 10px; }
  #knob { position: absolute; left: 0; top: 0; width: 20px; height: 20px; background: #000; }
  #src { width: 80px; height: 40px; background: #0a0; margin: 10px; display: inline-block; }
  #dst { width: 120px; height: 60px; background: #a0a; margin: 10px; display: inline-block; }
  #hov { width: 100px; height: 30px; background: #888; margin: 10px; } #hov:hover { background: #fa0; }
  #far { margin-top: 900px; }
</style></head><body>
<div id="red"></div>
<button id="btn">Click me</button> <button id="dis" disabled>Disabled</button>
<div id="out"></div>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent='submitted:' + event.isTrusted; window.__submitted = true;">
  <input id="q" name="q"> <button type="submit">Go</button>
</form>
<input id="t"> <input id="t2"> <textarea id="area"></textarea>
<input type="file" id="file"> <input type="file" id="one">
<button id="alertbtn" onclick="alert('hello dialog')">Alert</button>
<button id="confirmbtn" onclick="document.getElementById('out').textContent='confirm:' + confirm('sure?')">Confirm</button>
<div id="slider"><div id="knob"></div></div>
<div id="src" draggable="true">drag</div><div id="dst">drop</div>
<div id="hov">hover</div>
<div id="far">far down</div>
<script>
  window.events = [];
  const log = (type, e) => window.events.push({ type, isTrusted: e.isTrusted, key: e.key, data: e.data });
  const btn = document.getElementById('btn');
  btn.addEventListener('click', (e) => { document.getElementById('out').textContent = 'click:' + e.isTrusted; log('click', e); });
  btn.addEventListener('dblclick', (e) => log('dblclick', e));
  btn.addEventListener('contextmenu', (e) => log('contextmenu', e));
  for (const id of ['t', 'q']) {
    const el = document.getElementById(id);
    el.addEventListener('input', (e) => log('input:' + id, e));
    el.addEventListener('keydown', (e) => log('keydown:' + id, e));
  }
  const knob = document.getElementById('knob'), slider = document.getElementById('slider');
  let dragging = false;
  knob.addEventListener('mousedown', (e) => { dragging = e.isTrusted; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const r = slider.getBoundingClientRect();
    knob.style.left = Math.max(0, Math.min(280, e.clientX - r.left - 10)) + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  const dst = document.getElementById('dst');
  document.getElementById('src').addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'payload'); });
  dst.addEventListener('dragover', (e) => e.preventDefault());
  dst.addEventListener('drop', (e) => { e.preventDefault(); dst.textContent = 'dropped:' + e.dataTransfer.getData('text/plain'); });
  document.getElementById('file').addEventListener('change', (e) => log('change:file', e));
  console.log('hello-console', { a: 1 });
  console.warn('careful');
  fetch('/api/data?x=1', { headers: { Authorization: 'Bearer SECRET-TOKEN-VALUE', 'X-Custom': 'visible' } });
  fetch('/missing');
</script></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode an 8-bit non-interlaced PNG into { width, height, channels, rows[] }. */
function decodePng(base64) {
  const buf = Buffer.from(base64, 'base64');
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf[25];
  const channels = { 2: 3, 6: 4 }[colorType];
  assert.ok(channels, `unsupported PNG color type ${colorType}`);
  const chunks = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o);
    if (buf.subarray(o + 4, o + 8).toString() === 'IDAT') chunks.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 255;
    }
    rows.push(line);
    prev = line;
  }
  return { width, height, channels, rows };
}

const distinctColors = (png, step = 7) => {
  const seen = new Set();
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const o = x * png.channels;
      seen.add(`${png.rows[y][o]},${png.rows[y][o + 1]},${png.rows[y][o + 2]}`);
    }
  }
  return seen.size;
};

describe('CDP engine against Chrome for Testing', { skip: !ENABLED && 'set ARC_MCP_CDP_IT=1' }, () => {
  let chrome, profile, http, baseUrl, port;
  let client, engine, HANDLERS, deps, resolveTarget, CdpClient, CdpEngine;
  let targetA, targetB;
  const requestsSeen = [];
  const arcIds = {}; // fake Arc tab id -> targetId, for the test's marker writer

  const evalIn = async (targetId, expression) => {
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    try {
      const out = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { sessionId });
      return out.result.value;
    } finally {
      await client.send('Target.detachFromTarget', { sessionId });
    }
  };

  const waitReady = async (targetId) => {
    for (let i = 0; i < 100; i++) {
      if ((await evalIn(targetId, 'document.readyState')) === 'complete') return;
      await sleep(50);
    }
    throw new Error('page never finished loading');
  };

  // Stands in for the JXA write: puts the nonce into the page that fake Arc tab id is "in".
  const markTabFor = (tabId) => async (nonce) => {
    await evalIn(arcIds[tabId], `document.documentElement.setAttribute('data-arc-mcp-tab', ${JSON.stringify(nonce)}); true`);
    return { url: await evalIn(arcIds[tabId], 'location.href') };
  };

  // Calls a tool through the real registry wrapper, so schema validation applies.
  const call = (name, args) => HANDLERS[name](args);

  before(async () => {
    process.env.ARC_MCP_STATE_DIR = mkdtempSync(join(tmpdir(), 'arc-cdp-it-state-'));
    http = createServer((req, res) => {
      requestsSeen.push(req.url);
      if (req.url.startsWith('/api/data')) {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=SECRET-COOKIE; HttpOnly' });
        res.end('{"ok":true}');
        return;
      }
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });
    await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${http.address().port}/`;

    profile = mkdtempSync(join(tmpdir(), 'arc-cdp-it-profile-'));
    chrome = spawn(CHROME, [
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      ...(HEADLESS ? ['--headless=new'] : []), 'about:blank'
    ], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !port; i++) {
      try { port = Number(readFileSync(portFile, 'utf8').split('\n')[0]); } catch { await sleep(50); }
    }
    assert.ok(port, 'Chrome for Testing never wrote DevToolsActivePort');

    ({ CdpEngine } = await import('../src/cdp/engine.js'));
    ({ CdpClient } = await import('../src/cdp/client.js'));
    ({ deps, resolveTarget } = await import('../src/cdp/run.js'));
    ({ HANDLERS } = await import('../src/registry.js'));

    engine = new CdpEngine({ env: { ARC_MCP_CDP_PORT: String(port) } });
    const found = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    client = await CdpClient.connect(found.webSocketDebuggerUrl);

    // Test-only: Target.createTarget is how the fixture tabs come to exist. The
    // server itself never calls it, because it crashes Arc.
    ({ targetId: targetA } = await client.send('Target.createTarget', { url: baseUrl }));
    ({ targetId: targetB } = await client.send('Target.createTarget', { url: baseUrl, background: true }));
    arcIds['arc-A'] = targetA;
    arcIds['arc-B'] = targetB;
    await waitReady(targetA);
    await waitReady(targetB);

    deps.engine = engine;
    deps.resolveTab = async (args, ctx, eng) => {
      const tabId = args.tab_id;
      return { tabId, targetId: await resolveTarget(eng, tabId, markTabFor(tabId)) };
    };
  });

  after(async () => {
    engine?.close();
    client?.close();
    chrome?.kill('SIGKILL');
    http?.close();
    await sleep(200);
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it('probes and attaches, and reports the browser', async () => {
    const status = await call('cdp_status', {});
    assert.equal(status.ok, true);
    assert.match(status.browser, /Chrome/);
    assert.ok(status.targetCount >= 2);
    assert.match(status.warning, /unauthenticated/);
  });

  it('maps a tab through the marker even when two tabs share one URL', async () => {
    const a = await engine.mapper.resolve('arc-A', markTabFor('arc-A'));
    const b = await engine.mapper.resolve('arc-B', markTabFor('arc-B'));
    assert.equal(a, targetA);
    assert.equal(b, targetB);
    assert.notEqual(a, b, 'same URL, different tabs: the nonce must tell them apart');
    // Cached: a second resolve must not write a new marker.
    let marked = false;
    assert.equal(await engine.mapper.resolve('arc-A', async () => { marked = true; return {}; }), targetA);
    assert.equal(marked, false);
  });

  it('refuses a browser where no target carries the marker', async () => {
    arcIds['arc-ghost'] = targetA;
    await assert.rejects(
      () => engine.mapper.resolve('arc-ghost', async () => ({ url: baseUrl })), // writes nothing
      /Could not find this Arc tab/
    );
  });

  it('re-marks after a navigation drops the attribute', async () => {
    await client.send('Target.activateTarget', { targetId: targetA }).catch(() => {});
    const { sessionId } = await client.send('Target.attachToTarget', { targetId: targetA, flatten: true });
    await client.send('Page.reload', {}, { sessionId });
    await client.send('Target.detachFromTarget', { sessionId });
    await waitReady(targetA);
    let marked = false;
    const inner = markTabFor('arc-A');
    const id = await engine.mapper.resolve('arc-A', async (n) => { marked = true; return inner(n); });
    assert.equal(id, targetA);
    assert.equal(marked, true);
  });

  it('screenshots the active tab: a real PNG that is not blank', async () => {
    const out = await call('screenshot', { tab_id: 'arc-A' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.format, 'png');
    assert.ok(out.width >= 300 && out.height >= 200, `implausible size ${out.width}x${out.height}`);
    assert.ok(out.__image.data.length > 1000);
    const png = decodePng(out.__image.data);
    assert.equal(png.width, out.width);
    assert.ok(distinctColors(png) >= 4, 'screenshot looks uniformly blank');
  });

  it('screenshots a BACKGROUND tab without bringing it forward', async () => {
    const visibility = await evalIn(targetB, 'document.visibilityState');
    assert.equal(visibility, 'hidden', 'fixture error: tab B should be a background tab');
    const out = await call('screenshot', { tab_id: 'arc-B', timeout_ms: 8000 });
    assert.equal(out.ok, true, JSON.stringify(out));
    const png = decodePng(out.__image.data);
    assert.ok(png.width >= 300 && png.height >= 200);
    assert.ok(distinctColors(png) >= 4, `background screenshot looks blank (visibility ${visibility})`);
  });

  it('trusted input on a background tab is immediate, not a five second stall', async () => {
    const started = Date.now();
    const out = await call('trusted_click', { tab_id: 'arc-B', selector: '#btn' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
    assert.equal(await evalIn(targetB, "document.getElementById('out').textContent"), 'click:true');
  });

  it('screenshots an element by selector, at the element size', async () => {
    const out = await call('screenshot', { tab_id: 'arc-A', selector: '#red' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.scope, 'element');
    const png = decodePng(out.__image.data);
    const dpr = png.width / 200;
    assert.ok(dpr >= 1 && Number.isInteger(dpr), `width ${png.width} is not a multiple of 200`);
    assert.equal(png.height, 100 * dpr);
    const mid = png.rows[Math.floor(png.height / 2)];
    const o = Math.floor(png.width / 2) * png.channels;
    // Headful Chrome colour-manages to the display profile, so the exact RGB drifts: assert it is the red block.
    assert.ok(mid[o] > mid[o + 1] * 2 && mid[o] > mid[o + 2] * 2, `not red: ${[mid[o], mid[o + 1], mid[o + 2]]}`);
  });

  it('screenshots the full page taller than the viewport, and as jpeg', async () => {
    const viewport = await call('screenshot', { tab_id: 'arc-A' });
    const full = await call('screenshot', { tab_id: 'arc-A', full_page: true });
    assert.equal(full.ok, true, JSON.stringify(full));
    assert.ok(full.height > viewport.height, `full page ${full.height} not taller than viewport ${viewport.height}`);
    const jpeg = await call('screenshot', { tab_id: 'arc-A', format: 'jpeg', quality: 50 });
    assert.equal(jpeg.__image.mimeType, 'image/jpeg');
    assert.ok(jpeg.width > 0 && jpeg.height > 0);
  });

  it('trusted_click is seen by the page as isTrusted true, and a synthetic one is not', async () => {
    const out = await call('trusted_click', { tab_id: 'arc-A', selector: '#btn' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(await evalIn(targetA, "document.getElementById('out').textContent"), 'click:true');
    await evalIn(targetA, "document.getElementById('btn').click(); true");
    assert.equal(await evalIn(targetA, "document.getElementById('out').textContent"), 'click:false');
  });

  it('trusted_click refuses a disabled control and supports double and right clicks', async () => {
    const refused = await call('trusted_click', { tab_id: 'arc-A', selector: '#dis' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /disabled/);
    await evalIn(targetA, 'window.events.length = 0; true');
    await call('trusted_click', { tab_id: 'arc-A', selector: '#btn', click_count: 2 });
    await call('trusted_click', { tab_id: 'arc-A', selector: '#btn', button: 'right' });
    const types = await evalIn(targetA, 'window.events.map((e) => e.type + ":" + e.isTrusted)');
    assert.ok(types.includes('dblclick:true'), types.join());
    assert.ok(types.includes('contextmenu:true'), types.join());
  });

  it('trusted_press_key Enter really submits a form, and Tab really moves focus', async () => {
    await call('trusted_click', { tab_id: 'arc-A', selector: '#q' });
    const out = await call('trusted_press_key', { tab_id: 'arc-A', key: 'Enter' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(await evalIn(targetA, 'window.__submitted === true'), true, 'Enter did not submit the form');
    assert.equal(await evalIn(targetA, "document.getElementById('out').textContent"), 'submitted:true');

    await call('trusted_click', { tab_id: 'arc-A', selector: '#t' });
    const tab = await call('trusted_press_key', { tab_id: 'arc-A', key: 'Tab' });
    assert.equal(tab.activeElement?.id, 't2', JSON.stringify(tab));
  });

  it('trusted_press_key Meta+A selects all text in a field', async () => {
    await call('trusted_type', { tab_id: 'arc-A', selector: '#area', text: 'select me please' });
    const out = await call('trusted_press_key', { tab_id: 'arc-A', key: 'Meta+A' });
    assert.equal(out.ok, true, JSON.stringify(out));
    const selected = await evalIn(targetA, "(() => { const a = document.getElementById('area'); return a.selectionEnd - a.selectionStart; })()");
    assert.equal(selected, 'select me please'.length);
  });

  it('trusted_type fires per-character trusted input events with per_key', async () => {
    await evalIn(targetA, "window.events.length = 0; document.getElementById('t').value = ''; true");
    const out = await call('trusted_type', { tab_id: 'arc-A', selector: '#t', text: 'abc', per_key: true });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.after.value, 'abc');
    const events = await evalIn(targetA, 'window.events.filter((e) => e.type.endsWith(":t"))');
    const inputs = events.filter((e) => e.type === 'input:t');
    assert.equal(inputs.length, 3, JSON.stringify(events));
    assert.ok(inputs.every((e) => e.isTrusted));
    assert.deepEqual(events.filter((e) => e.type === 'keydown:t').map((e) => e.key), ['a', 'b', 'c']);
  });

  it('trusted_type inserts text in one trusted input event, and clear replaces', async () => {
    await evalIn(targetA, "window.events.length = 0; true");
    await call('trusted_type', { tab_id: 'arc-A', selector: '#t', text: 'hello world', clear: true });
    assert.equal(await evalIn(targetA, "document.getElementById('t').value"), 'hello world');
    const inputs = await evalIn(targetA, "window.events.filter((e) => e.type === 'input:t')");
    assert.ok(inputs.every((e) => e.isTrusted));
    const cleared = await call('trusted_type', { tab_id: 'arc-A', selector: '#t', text: '', clear: true });
    assert.equal(cleared.ok, true);
    assert.equal(await evalIn(targetA, "document.getElementById('t').value"), '', 'clear with empty text did not empty the field');
  });

  it('trusted_hover applies :hover', async () => {
    const out = await call('trusted_hover', { tab_id: 'arc-A', selector: '#hov' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.hoverApplied, true);
  });

  it('drag moves a slider with trusted mouse events and drops a native HTML5 drag', async () => {
    const rect = await evalIn(targetA, "(() => { document.getElementById('slider').scrollIntoView({block:'center'}); const r = document.getElementById('slider').getBoundingClientRect(); return {x: r.left, y: r.top + 10}; })()");
    const moved = await call('drag', { tab_id: 'arc-A', from_selector: '#knob', to_x: rect.x + 210, to_y: rect.y, steps: 6 });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const left = await evalIn(targetA, "parseFloat(document.getElementById('knob').style.left)");
    assert.ok(left > 150, `knob only moved to ${left}`);

    const dnd = await call('drag', { tab_id: 'arc-A', from_selector: '#src', to_selector: '#dst' });
    assert.equal(dnd.ok, true, JSON.stringify(dnd));
    assert.equal(await evalIn(targetA, "document.getElementById('dst').textContent"), 'dropped:payload', JSON.stringify(dnd));
  });

  it('console_messages and network_requests capture what the page did after attach', async () => {
    await call('trusted_click', { tab_id: 'arc-B', selector: '#btn' }); // first attach to B
    // Run page code that logs and fetches after attach.
    await evalIn(targetB, "console.log('after-attach', 42); console.error('boom'); fetch('/api/data?after=1', { method: 'POST', headers: { Authorization: 'Bearer SECRET-TOKEN-VALUE' } }).then(() => 1); true");
    await sleep(500);
    const logs = await call('console_messages', { tab_id: 'arc-B' });
    assert.equal(logs.ok, true);
    assert.ok(logs.entries.some((e) => e.text === 'after-attach 42' && e.level === 'log'), JSON.stringify(logs.entries));
    assert.ok(logs.entries.some((e) => e.text === 'boom' && e.level === 'error'));
    const errorsOnly = await call('console_messages', { tab_id: 'arc-B', level: 'error' });
    assert.ok(errorsOnly.entries.every((e) => e.level === 'error'));

    const net = await call('network_requests', { tab_id: 'arc-B', url_contains: '/api/data?after' });
    assert.equal(net.entries.length, 1, JSON.stringify(net));
    const [req] = net.entries;
    assert.equal(req.method, 'POST');
    assert.equal(req.status, 200);
    assert.ok(req.durationMs >= 0 && req.encodedBytes > 0);
    assert.equal(req.requestHeaders, undefined, 'headers must be opt-in');

    const withHeaders = await call('network_requests', { tab_id: 'arc-B', url_contains: '/api/data?after', include_headers: true });
    const headers = withHeaders.entries[0];
    const text = JSON.stringify(headers);
    assert.ok(!text.includes('SECRET-TOKEN-VALUE'), 'authorization value leaked');
    assert.ok(!text.includes('SECRET-COOKIE'), 'set-cookie value leaked');
    assert.equal(headers.requestHeaders.Authorization, '[redacted]');

    const failed = await call('network_requests', { tab_id: 'arc-B', failed_only: true });
    assert.ok(failed.entries.every((e) => e.failed || e.status >= 400));
    assert.ok(requestsSeen.some((u) => u.includes('after=1')), 'the local server never saw the fetch');
  });

  it('upload_file sets files, and refuses relative, missing and sensitive paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc-cdp-upload-'));
    const file = join(dir, 'hello.txt');
    writeFileSync(file, 'hello upload');
    try {
      await evalIn(targetA, 'window.events.length = 0; true');
      const out = await call('upload_file', { tab_id: 'arc-A', selector: '#file', paths: [file] });
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.deepEqual(out.files, [{ name: 'hello.txt', size: 12 }]);
      assert.equal(await evalIn(targetA, "document.getElementById('file').files[0].name"), 'hello.txt');
      assert.equal(await evalIn(targetA, "window.events.some((e) => e.type === 'change:file')"), true, 'no change event');

      await assert.rejects(() => call('upload_file', { tab_id: 'arc-A', selector: '#file', paths: ['relative.txt'] }), /absolute/);
      await assert.rejects(() => call('upload_file', { tab_id: 'arc-A', selector: '#file', paths: [join(dir, 'nope.txt')] }), /does not exist/);
      const notFile = await call('upload_file', { tab_id: 'arc-A', selector: '#btn', paths: [file] });
      assert.equal(notFile.ok, false);
      const tooMany = await call('upload_file', { tab_id: 'arc-A', selector: '#one', paths: [file, file] });
      assert.equal(tooMany.ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a dialog is reported, blocks other tools with a pointer, and handle_dialog clears it', async () => {
    const clicked = await call('trusted_click', { tab_id: 'arc-A', selector: '#alertbtn' });
    assert.equal(clicked.ok, true, JSON.stringify(clicked));
    assert.equal(clicked.dialog?.type, 'alert');
    assert.equal(clicked.dialog?.message, 'hello dialog');

    const blocked = await call('trusted_type', { tab_id: 'arc-A', selector: '#t', text: 'x' });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /handle_dialog/);

    const handled = await call('handle_dialog', { tab_id: 'arc-A', action: 'accept' });
    assert.equal(handled.ok, true, JSON.stringify(handled));
    assert.equal(handled.handled.message, 'hello dialog');

    const none = await call('handle_dialog', { tab_id: 'arc-A', action: 'accept' });
    assert.equal(none.ok, false);

    // A confirm the page acts on: dismiss means confirm() returned false.
    await call('trusted_click', { tab_id: 'arc-A', selector: '#confirmbtn' });
    await call('handle_dialog', { tab_id: 'arc-A', action: 'dismiss' });
    await sleep(100);
    assert.equal(await evalIn(targetA, "document.getElementById('out').textContent"), 'confirm:false');
  });

  it('cancellation and timeouts surface as failures, not hangs', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await HANDLERS.screenshot({ tab_id: 'arc-A' }, { signal: controller.signal });
    assert.equal(out.ok, false);
    assert.match(out.error, /Cancelled/);
  });
});
