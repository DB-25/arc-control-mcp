// Configuration, probing, the failed-probe cache, tab mapping and the
// disabled-mode behaviour of the CDP tools. All against fakes: no browser.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  cdpConfig, probe, checkCdp, setupInstructions, CdpEngine, CdpUnavailable, DEFAULT_PORT, FAILED_PROBE_TTL_MS
} from '../src/cdp/engine.js';
import { NEEDS_NODE_22 } from '../src/cdp/client.js';
import { TabMapper, MappingError, urlsMatch, normalizeUrl } from '../src/cdp/mapping.js';
import { HANDLERS } from '../src/registry.js';
import { deps } from '../src/cdp/run.js';

const WS_URL = 'ws://127.0.0.1:9222/devtools/browser/abc';
const okProbe = { ok: true, browser: 'Chrome/153', protocolVersion: '1.3', wsUrl: WS_URL };

describe('cdpConfig', () => {
  it('is on by default and probes 9222', () => {
    assert.deepEqual(cdpConfig({}), { enabled: true, port: DEFAULT_PORT, source: 'default' });
    assert.equal(DEFAULT_PORT, 9222);
  });

  it('honours ARC_MCP_CDP_PORT, and ARC_MCP_CDP=0 switches the engine off', () => {
    assert.equal(cdpConfig({ ARC_MCP_CDP_PORT: '9333' }).port, 9333);
    for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
      const config = cdpConfig({ ARC_MCP_CDP: off, ARC_MCP_CDP_PORT: '9333' });
      assert.equal(config.enabled, false, `ARC_MCP_CDP=${off}`);
      assert.match(config.reason, /switched off/);
    }
  });

  it('reports an unusable port instead of quietly falling back to 9222', () => {
    for (const bad of ['abc', '0', '70000', '9222.5', '-1']) {
      const config = cdpConfig({ ARC_MCP_CDP_PORT: bad });
      assert.equal(config.enabled, false, bad);
      assert.match(config.reason, /not a port number/);
    }
  });

  it('ARC_MCP_CDP=1 still means the default port', () => {
    assert.equal(cdpConfig({ ARC_MCP_CDP: '1' }).port, 9222);
  });
});

describe('probe', () => {
  const answer = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });

  it('rebuilds the WebSocket URL from our own host and port, ignoring what the endpoint claims', async () => {
    const found = await probe(9222, {
      fetchImpl: answer({ Browser: 'Chrome/153', 'Protocol-Version': '1.3', webSocketDebuggerUrl: 'ws://evil.example:80/devtools/browser/xyz' })
    });
    assert.equal(found.ok, true);
    assert.equal(found.wsUrl, 'ws://127.0.0.1:9222/devtools/browser/xyz');
  });

  it('rejects an answer that is not a browser DevTools endpoint', async () => {
    const wrongPath = await probe(9222, { fetchImpl: answer({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/something/else' }) });
    assert.equal(wrongPath.ok, false);
    assert.equal((await probe(9222, { fetchImpl: answer({}, 404) })).ok, false);
    assert.equal((await probe(9222, { fetchImpl: answer({ nothing: true }) })).ok, false);
  });

  it('says nothing is listening when the connection is refused, and times out distinctly', async () => {
    const refused = await probe(9222, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.match(refused.reason, /Nothing is listening on 127\.0\.0\.1:9222/);
    const slow = await probe(9222, { fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
    assert.match(slow.reason, /did not answer/);
  });
});

describe('checkCdp (the --check-cdp helper)', () => {
  it('prints status and the security warning when the port answers', async () => {
    const fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/json/list')
        ? [{ type: 'page' }, { type: 'page' }, { type: 'service_worker' }]
        : { Browser: 'Chrome/153', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/q' })
    });
    const out = await checkCdp({ env: {}, fetchImpl });
    assert.equal(out.ok, true);
    const text = out.lines.join('\n');
    assert.match(text, /Chrome\/153/);
    assert.match(text, /pages:\s+2/);
    assert.match(text, /unauthenticated/);
  });

  it('prints the setup steps when nothing answers, and is silent about disabled mode', async () => {
    const down = await checkCdp({ env: {}, fetchImpl: async () => { throw new TypeError('refused'); } });
    assert.equal(down.ok, false);
    assert.match(down.lines.join('\n'), /open -a Arc --args --remote-debugging-port=9222/);
    const off = await checkCdp({ env: { ARC_MCP_CDP: '0' } });
    assert.equal(off.ok, false);
    assert.match(off.lines[0], /switched off/);
  });
});

describe('CdpEngine connection handling', () => {
  const fakeClient = () => ({ closed: false, on() {}, onClose() {}, send: async () => ({}), close() {} });

  it('caches a failed probe for the TTL so ordinary use never re-pays for it, and re-probes after', async () => {
    let probes = 0;
    let clock = 1000;
    const engine = new CdpEngine({ env: {}, now: () => clock, probeFn: async () => { probes++; return { ok: false, reason: 'Nothing is listening on 127.0.0.1:9222.' }; } });
    for (let i = 0; i < 4; i++) await assert.rejects(engine.connection(), CdpUnavailable);
    assert.equal(probes, 1, 'four calls inside the TTL must probe once');
    clock += FAILED_PROBE_TTL_MS + 1;
    await assert.rejects(engine.connection(), CdpUnavailable);
    assert.equal(probes, 2);
  });

  it('a fresh probe (cdp_status) bypasses the failure cache', async () => {
    let probes = 0;
    const engine = new CdpEngine({ env: {}, now: () => 1, probeFn: async () => { probes++; return { ok: false, reason: 'down' }; } });
    await assert.rejects(engine.connection());
    await assert.rejects(engine.connection({ fresh: true }));
    assert.equal(probes, 2);
  });

  it('the failure carries the setup steps for the configured port', async () => {
    const engine = new CdpEngine({ env: { ARC_MCP_CDP_PORT: '9333' }, probeFn: async () => ({ ok: false, reason: 'down' }) });
    await assert.rejects(engine.connection(), (e) => e.port === 9333 && /--remote-debugging-port=9333/.test(e.setup));
  });

  it('opens one connection and reuses it', async () => {
    let connects = 0;
    const engine = new CdpEngine({ env: {}, probeFn: async () => okProbe, connectFn: async () => { connects++; return fakeClient(); } });
    const [a, b] = await Promise.all([engine.connection(), engine.connection()]);
    assert.equal(a, b);
    await engine.connection();
    assert.equal(connects, 1);
  });

  it('a successful connection clears an earlier failure', async () => {
    let up = false;
    let clock = 0;
    const engine = new CdpEngine({ env: {}, now: () => clock, probeFn: async () => (up ? okProbe : { ok: false, reason: 'down' }), connectFn: async () => fakeClient() });
    await assert.rejects(engine.connection());
    up = true;
    clock += FAILED_PROBE_TTL_MS + 1;
    assert.ok(await engine.connection());
  });

  it('refuses when disabled, without probing', async () => {
    let probes = 0;
    const engine = new CdpEngine({ env: { ARC_MCP_CDP: '0' }, probeFn: async () => { probes++; return okProbe; } });
    await assert.rejects(engine.connection(), (e) => e instanceof CdpUnavailable && e.enabled === false);
    assert.equal(probes, 0);
  });

  it('names Node 22 when the runtime has no WebSocket', async () => {
    const saved = globalThis.WebSocket;
    globalThis.WebSocket = undefined;
    try {
      const engine = new CdpEngine({ env: {}, probeFn: async () => okProbe });
      await assert.rejects(engine.connection(), (e) => e.message === NEEDS_NODE_22);
    } finally {
      globalThis.WebSocket = saved;
    }
  });
});

describe('TabMapper', () => {
  const backend = (targets, markers = {}) => ({
    reads: [],
    async listPageTargets() { return targets; },
    async readMarker(id) { this.reads.push(id); return markers[id] ?? null; }
  });
  const noSleep = async () => {};
  const mapper = (b, nonce = 'N1', extra = {}) => new TabMapper(b, { newNonce: () => nonce, sleep: noSleep, ...extra });

  it('picks the one target that carries the nonce, even when URLs are identical', async () => {
    const markers = {};
    const b = backend([{ targetId: 'T1', url: 'https://a.test/' }, { targetId: 'T2', url: 'https://a.test/' }], markers);
    const m = mapper(b);
    const id = await m.resolve('arc-1', async (nonce) => { markers.T2 = nonce; return { url: 'https://a.test/' }; });
    assert.equal(id, 'T2');
  });

  it('REJECTS a target without the marker: a different Chromium on the port is never driven', async () => {
    // Every page matches the URL and none carries the nonce Arc was told to write.
    const b = backend([{ targetId: 'X1', url: 'https://a.test/' }, { targetId: 'X2', url: 'https://other.test/' }]);
    await assert.rejects(
      mapper(b).resolve('arc-1', async () => ({ url: 'https://a.test/' })),
      (e) => e instanceof MappingError && /1 page target\(s\) at the tab's address were checked \(of 2 on the port\)/.test(e.message) && /different browser/.test(e.message)
    );
  });

  it('rejects a target holding a stale or foreign marker value', async () => {
    const b = backend([{ targetId: 'T1', url: 'https://a.test/' }], { T1: 'someone-elses-nonce' });
    await assert.rejects(mapper(b, 'N1').resolve('arc-1', async () => ({ url: 'https://a.test/' })), MappingError);
  });

  it('still finds the tab when its URL moved between the Apple Event and the listing, on the one retry', async () => {
    const markers = {};
    const b = backend([{ targetId: 'T9', url: 'https://redirected.test/final' }], markers);
    const waits = [];
    const m = mapper(b, 'N1', { sleep: async (ms) => { waits.push(ms); } });
    let call = 0;
    const id = await m.resolve('arc-1', async (nonce) => {
      markers.T9 = nonce;
      // The first Apple Event still saw the old address; by the retry it has settled.
      return { url: ++call === 1 ? 'https://a.test/start' : 'https://redirected.test/final' };
    });
    assert.equal(id, 'T9');
    assert.equal(call, 2);
    assert.deepEqual(waits, [400], 'one short wait before the retry');
    assert.deepEqual(b.reads, ['T9'], 'only the matching target was ever probed');
  });

  it('matches a target whose URL differs only by fragment or trailing slash', async () => {
    const markers = { T1: 'N1' };
    const b = backend([{ targetId: 'T1', url: 'https://a.test/page#section-2' }], markers);
    assert.equal(await mapper(b).resolve('arc-1', async () => ({ url: 'https://a.test/page/' })), 'T1');
  });

  it('never probes a target at another address, however many pages are open', async () => {
    const markers = {};
    const targets = [
      { targetId: 'SAME', url: 'https://a.test/' },
      { targetId: 'BANK', url: 'https://bank.test/account' },
      { targetId: 'MAIL', url: 'https://mail.test/inbox' }
    ];
    const b = backend(targets, markers);
    const id = await mapper(b).resolve('arc-1', async (nonce) => { markers.SAME = nonce; return { url: 'https://a.test/' }; });
    assert.equal(id, 'SAME');
    assert.deepEqual(b.reads, ['SAME']);
    // And when the tab is not found, still only the matching one is touched (twice: the retry).
    const b2 = backend(targets, {});
    await assert.rejects(mapper(b2).resolve('arc-2', async () => ({ url: 'https://a.test/' })), MappingError);
    assert.ok(b2.reads.every((r) => r === 'SAME'), `probed ${b2.reads}`);
    assert.equal(b2.reads.length, 2);
  });

  it('never probes a target on an origin the guardrails block, and says why', async () => {
    const b = backend([{ targetId: 'BANK', url: 'https://bank.test/account' }], { BANK: 'N1' });
    const m = mapper(b, 'N1', { isBlocked: (url) => url.startsWith('https://bank.test') });
    await assert.rejects(
      m.resolve('arc-1', async () => ({ url: 'https://bank.test/account' })),
      (e) => e instanceof MappingError && /guardrails block/.test(e.message)
    );
    assert.deepEqual(b.reads, [], 'not even the marker was read');
  });

  it('caches, and revalidates on every use without re-marking while the marker holds', async () => {
    const markers = {};
    const b = backend([{ targetId: 'T1', url: 'u' }], markers);
    const m = mapper(b);
    let marks = 0;
    const mark = async (nonce) => { marks++; markers.T1 = nonce; return { url: 'u' }; };
    await m.resolve('arc-1', mark);
    await m.resolve('arc-1', mark);
    assert.equal(marks, 1);
    assert.equal(m.cached('arc-1'), 'T1');
  });

  it('re-marks when the marker is gone (the page navigated), and when the target vanished', async () => {
    const markers = {};
    const b = backend([{ targetId: 'T1', url: 'u' }], markers);
    let n = 0;
    const m = new TabMapper(b, { newNonce: () => `N${++n}` });
    let marks = 0;
    const mark = async (nonce) => { marks++; markers.T1 = nonce; return { url: 'u' }; };
    await m.resolve('arc-1', mark);
    delete markers.T1;
    assert.equal(await m.resolve('arc-1', mark), 'T1');
    assert.equal(marks, 2);
    // Target gone entirely: the stale cache entry must not be trusted.
    b.listPageTargets = async () => [];
    delete markers.T1;
    await assert.rejects(m.resolve('arc-1', mark), MappingError);
    assert.equal(m.cached('arc-1'), null);
  });

  it('concurrent resolves of one tab share a single marking', async () => {
    const markers = {};
    const b = backend([{ targetId: 'T1', url: 'u' }], markers);
    const m = mapper(b);
    let marks = 0;
    const mark = async (nonce) => { marks++; markers.T1 = nonce; return { url: 'u' }; };
    const results = await Promise.all([m.resolve('arc-1', mark), m.resolve('arc-1', mark), m.resolve('arc-1', mark)]);
    assert.deepEqual(results, ['T1', 'T1', 'T1']);
    assert.equal(marks, 1);
  });

  it('propagates a failure to mark the tab', async () => {
    const m = mapper(backend([{ targetId: 'T1', url: 'u' }]));
    await assert.rejects(m.resolve('arc-1', async () => { throw new Error('Arc is blocking JavaScript'); }), /blocking JavaScript/);
  });

  it('compares URLs without the fragment or a trailing slash, and never matches empty ones', () => {
    assert.equal(normalizeUrl('https://a.test/x#frag'), 'https://a.test/x');
    assert.equal(urlsMatch('https://a.test/', 'https://a.test'), true);
    assert.equal(urlsMatch('', ''), false);
    assert.equal(urlsMatch('https://a.test/x', 'https://a.test/y'), false);
  });
});

describe('an engine pointed at a browser that never carries the marker', () => {
  it('lists, probes and detaches, and never enables a domain or sends input', async () => {
    const sent = [];
    const client = {
      closed: false,
      on() {}, onClose() {},
      session: () => { throw new Error('must not attach a tab session'); },
      close() {},
      send: async (method) => {
        sent.push(method);
        if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'FOREIGN', type: 'page', url: 'https://a.test/', title: 'a' }] };
        if (method === 'Target.attachToTarget') return { sessionId: 'S' };
        if (method === 'Runtime.evaluate') return { result: { value: null } };
        return {};
      }
    };
    const engine = new CdpEngine({ env: {}, probeFn: async () => okProbe, connectFn: async () => client, sleep: async () => {} });
    await assert.rejects(engine.mapper.resolve('arc-1', async () => ({ url: 'https://a.test/' })), MappingError);
    assert.deepEqual(
      [...new Set(sent)].sort(),
      ['Runtime.evaluate', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.getTargets']
    );
  });
});

describe('every CDP tool when CDP cannot be used', () => {
  const original = { engine: deps.engine, resolveTab: deps.resolveTab };
  afterEach(() => Object.assign(deps, original));

  const CDP_TOOLS = {
    screenshot: {},
    trusted_click: { selector: '#a' },
    trusted_type: { text: 'x' },
    trusted_press_key: { key: 'Enter' },
    trusted_hover: { selector: '#a' },
    drag: { from_x: 1, from_y: 1, to_x: 2, to_y: 2 },
    upload_file: { selector: 'input', paths: ['/tmp/x'] },
    handle_dialog: { action: 'accept' },
    console_messages: {},
    network_requests: {}
  };

  const neverResolves = async () => { throw new Error('resolved an Arc tab although CDP is unavailable'); };

  for (const [name, args] of Object.entries(CDP_TOOLS)) {
    it(`${name} fails with ok false and the setup steps when nothing answers on the port`, async () => {
      deps.engine = new CdpEngine({ env: {}, probeFn: async () => ({ ok: false, reason: 'Nothing is listening on 127.0.0.1:9222.' }) });
      deps.resolveTab = neverResolves; // proves Arc is not even asked
      const out = await HANDLERS[name](args);
      assert.equal(out.ok, false);
      assert.match(out.error, /Nothing is listening on 127\.0\.0\.1:9222/);
      assert.match(out.setup, /open -a Arc --args --remote-debugging-port=9222/);
      assert.match(out.setup, /Cmd-Q/);
    });

    it(`${name} says CDP is switched off when ARC_MCP_CDP=0`, async () => {
      deps.engine = new CdpEngine({ env: { ARC_MCP_CDP: '0' } });
      deps.resolveTab = neverResolves;
      const out = await HANDLERS[name](args);
      assert.equal(out.ok, false);
      assert.match(out.error, /switched off by ARC_MCP_CDP=0/);
      assert.equal(out.enabled, false);
    });
  }

  it('cdp_status reports the state and the warning, and fails with setup when unreachable', async () => {
    deps.engine = new CdpEngine({ env: {}, probeFn: async () => ({ ok: false, reason: 'Nothing is listening on 127.0.0.1:9222.' }) });
    const out = await HANDLERS.cdp_status({});
    assert.equal(out.ok, false);
    assert.equal(out.enabled, true);
    assert.equal(out.reachable, false);
    assert.equal(out.port, 9222);
    assert.match(out.warning, /unauthenticated/);
    assert.equal(out.setup, setupInstructions(9222));
  });

  it('cdp_status for a disabled engine names the switch rather than the setup steps', async () => {
    deps.engine = new CdpEngine({ env: { ARC_MCP_CDP: '0' } });
    const out = await HANDLERS.cdp_status({});
    assert.equal(out.ok, false);
    assert.equal(out.enabled, false);
    assert.equal(out.setup, undefined);
    assert.match(out.error, /switched off/);
  });

  it('screenshot refuses selector with full_page before touching anything', async () => {
    deps.engine = new CdpEngine({ env: {}, probeFn: async () => { throw new Error('should not probe'); } });
    const out = await HANDLERS.screenshot({ selector: '#a', full_page: true });
    assert.equal(out.ok, false);
    assert.match(out.error, /either selector or full_page/);
  });
});

describe('arc-control-mcp --check-cdp', () => {
  it('probes only, prints the setup steps and exits 1 when nothing answers, without serving', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    const server = fileURLToPath(new URL('../src/index.js', import.meta.url));
    // Port 1 is never serving DevTools, so this cannot touch a real Arc.
    const run = promisify(execFile)(process.execPath, [server, '--check-cdp'], { env: { ...process.env, ARC_MCP_CDP_PORT: '1' } });
    await assert.rejects(run, (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /No DevTools port on 127\.0\.0\.1:1/);
      assert.match(error.stdout, /open -a Arc --args --remote-debugging-port=1/);
      assert.doesNotMatch(error.stderr, /running on stdio/);
      return true;
    });
  });
});

describe('the engine hands the guardrails to the tab mapper', () => {
  it('does not probe a target the block list forbids, using the real policy rules', async () => {
    const { loadPolicy } = await import('../src/policy.js');
    const reads = [];
    const client = {
      closed: false, on() {}, onClose() {}, close() {},
      session: () => { throw new Error('must not attach a tab session'); },
      send: async (method, params) => {
        if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'BANK', type: 'page', url: 'https://www.bank.test/', title: 'b' }] };
        if (method === 'Target.attachToTarget') { reads.push(params.targetId); return { sessionId: 'S' }; }
        return { result: { value: null } };
      }
    };
    const engine = new CdpEngine({
      env: {}, probeFn: async () => okProbe, connectFn: async () => client, sleep: async () => {},
      policy: loadPolicy({ ARC_MCP_BLOCKED_ORIGINS: '*.bank.test' })
    });
    await assert.rejects(engine.mapper.resolve('arc-1', async () => ({ url: 'https://www.bank.test/' })), /guardrails block/);
    assert.deepEqual(reads, [], 'no attach, so no script ran in the blocked page');
  });
});
