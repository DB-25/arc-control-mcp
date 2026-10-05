/**
 * The CDP engine: configuration, port probing, one lazily opened connection to
 * the browser, and one attached session per tab.
 *
 * It is on by default but costs nothing until a CDP tool is called: no tool
 * outside src/tools/cdp.js ever touches it, and a failed probe is remembered
 * briefly so a browser without the debugging port is not re-probed per call.
 *
 * Arc is only ever attached to, never asked to create anything:
 * Target.createTarget crashes it. Tabs come from Apple Events as before.
 */
import { CdpClient, CdpError, NEEDS_NODE_22, hasWebSocket } from './client.js';
import { TabCapture } from './capture.js';
import { TabMapper, MARKER_ATTRIBUTE } from './mapping.js';

// Fixed on purpose. A configurable host would let a typo (or a hostile
// environment) point a session-reading debugger at another machine.
export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 9222;
export const PROBE_TIMEOUT_MS = 1500;
// How long a failed probe is believed. Short, so launching Arc with the flag is
// noticed within seconds; long enough that ordinary use never pays for it.
export const FAILED_PROBE_TTL_MS = 10000;
const MARKER_READ_TIMEOUT_MS = 3000;
// Preserved response payloads are never read here, so keep the browser's
// per-tab buffer small.
const NETWORK_BUFFER_BYTES = 1024 * 1024;

export const SECURITY_WARNING =
  'The DevTools port is unauthenticated and bound to loopback: any process running as you on this Mac ' +
  'can drive Arc through it, read page content and use your logged-in sessions. Leave it on only if you ' +
  'accept that. Disable it with ARC_MCP_CDP=0 and relaunch Arc without --remote-debugging-port.';

/**
 * ARC_MCP_CDP=0 turns the engine off, ARC_MCP_CDP_PORT picks another port, and
 * otherwise 9222 is probed. An unusable port is reported rather than quietly
 * replaced by the default.
 */
export function cdpConfig(env = process.env) {
  const flag = String(env.ARC_MCP_CDP ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(flag)) {
    return { enabled: false, port: null, source: 'ARC_MCP_CDP', reason: 'CDP is switched off by ARC_MCP_CDP=0.' };
  }
  const raw = env.ARC_MCP_CDP_PORT;
  if (raw !== undefined && String(raw).trim() !== '') {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { enabled: false, port: null, source: 'ARC_MCP_CDP_PORT', reason: `ARC_MCP_CDP_PORT=${JSON.stringify(raw)} is not a port number (1-65535).` };
    }
    return { enabled: true, port, source: 'ARC_MCP_CDP_PORT' };
  }
  return { enabled: true, port: DEFAULT_PORT, source: 'default' };
}

export function setupInstructions(port = DEFAULT_PORT) {
  return [
    'Arc only serves the DevTools port when it is launched with a flag, and never does by default:',
    '1. Quit Arc completely (Cmd-Q). It restores your tabs on the next launch.',
    `2. Relaunch it: open -a Arc --args --remote-debugging-port=${port}`,
    `3. Check it answers: curl -s ${HOST}:${port}/json/version  (or run: arc-control-mcp --check-cdp)`,
    '4. To keep the flag across Arc updates, see scripts/arc-cdp-healer.sh and scripts/arc-cdp-setup.md.',
    'If nothing answers after that, this Arc build may ignore the flag on the default profile.',
    'Every other tool works without any of this.'
  ].join('\n');
}

/** Why CDP cannot be used right now, with what to do about it. */
export class CdpUnavailable extends Error {
  constructor(message, { port = null, setup = null, enabled = true } = {}) {
    super(message);
    this.name = 'CdpUnavailable';
    this.port = port;
    this.setup = setup;
    this.enabled = enabled;
  }
}

/** Ask the port who it is. Never throws: an answer is either { ok: true, ... } or { ok: false, reason }. */
export async function probe(port, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const response = await fetchImpl(`http://${HOST}:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, reason: `${HOST}:${port} answered HTTP ${response.status}, which is not a DevTools endpoint.` };
    const body = await response.json();
    const path = new URL(body.webSocketDebuggerUrl).pathname;
    if (!path.startsWith('/devtools/browser/')) return { ok: false, reason: `${HOST}:${port} did not return a browser DevTools endpoint.` };
    // Rebuilt from our fixed host and port, so the endpoint cannot redirect us elsewhere.
    return {
      ok: true,
      browser: body.Browser,
      protocolVersion: body['Protocol-Version'],
      userAgent: body['User-Agent'],
      wsUrl: `ws://${HOST}:${port}${path}`
    };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError';
    return { ok: false, reason: timedOut ? `${HOST}:${port} did not answer within ${timeoutMs}ms.` : `Nothing is listening on ${HOST}:${port}.` };
  }
}

/** The non-destructive `--check-cdp` helper: probe and describe, change nothing. */
export async function checkCdp({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = cdpConfig(env);
  if (!config.enabled) return { ok: false, lines: [config.reason] };
  const found = await probe(config.port, { fetchImpl });
  if (!found.ok) {
    return { ok: false, lines: [`No DevTools port on ${HOST}:${config.port}: ${found.reason}`, '', setupInstructions(config.port)] };
  }
  const lines = [`DevTools port answering on ${HOST}:${config.port}`, `  browser:  ${found.browser}`];
  try {
    const list = await (await fetchImpl(`http://${HOST}:${config.port}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).json();
    lines.push(`  pages:    ${list.filter((t) => t.type === 'page').length}`);
  } catch {
    lines.push('  pages:    (could not list)');
  }
  lines.push('', `Warning: ${SECURITY_WARNING}`);
  return { ok: true, lines };
}

export class CdpEngine {
  #client = null;
  #clientPort = null;
  #connecting = null;
  #failure = null;
  #info = null;
  tabs = new Map();

  constructor({ env = process.env, probeFn = probe, connectFn = CdpClient.connect, now = Date.now, failTtlMs = FAILED_PROBE_TTL_MS } = {}) {
    this.env = env;
    this.probeFn = probeFn;
    this.connectFn = connectFn;
    this.now = now;
    this.failTtlMs = failTtlMs;
    this.mapper = new TabMapper(this);
  }

  config() {
    return cdpConfig(this.env);
  }

  /** The live connection, opening it when needed. Throws CdpUnavailable with the setup steps. */
  async connection({ fresh = false } = {}) {
    const config = this.config();
    if (!config.enabled) throw new CdpUnavailable(config.reason, { enabled: false });
    if (!hasWebSocket()) throw new CdpUnavailable(NEEDS_NODE_22, { port: config.port });
    if (this.#client && !this.#client.closed && this.#clientPort === config.port) return this.#client;

    const recent = this.#failure;
    if (!fresh && recent && recent.port === config.port && this.now() - recent.at < this.failTtlMs) throw recent.error;

    this.#connecting ??= this.#connect(config).finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async #connect(config) {
    const fail = (message) => {
      const error = new CdpUnavailable(message, { port: config.port, setup: setupInstructions(config.port) });
      this.#failure = { at: this.now(), port: config.port, error };
      throw error;
    };
    const found = await this.probeFn(config.port);
    if (!found.ok) fail(found.reason);
    let client;
    try {
      client = await this.connectFn(found.wsUrl);
    } catch (error) {
      fail(`The DevTools port answered but refused a WebSocket connection: ${error.message}`);
    }
    this.#failure = null;
    this.#info = found;
    this.#client = client;
    this.#clientPort = config.port;
    client.on('Target.detachedFromTarget', ({ sessionId }) => this.#dropSession(sessionId));
    client.on('Target.targetDestroyed', ({ targetId }) => this.#dropTarget(targetId));
    client.onClose(() => {
      if (this.#client === client) this.#client = null;
      this.tabs.clear();
      this.mapper.clear();
    });
    return client;
  }

  #dropSession(sessionId) {
    for (const [targetId, tab] of this.tabs) if (tab.sessionId === sessionId) this.#dropTarget(targetId);
  }

  #dropTarget(targetId) {
    const tab = this.tabs.get(targetId);
    if (tab) tab.closed = true;
    this.tabs.delete(targetId);
  }

  /** Fresh probe for cdp_status: bypasses the failure cache, since the user may just have launched Arc. */
  async status() {
    const config = this.config();
    if (!config.enabled) return { config, reachable: false, reason: config.reason };
    try {
      await this.connection({ fresh: true });
      const targets = await this.listPageTargets();
      return { config, reachable: true, browser: this.#info?.browser, protocolVersion: this.#info?.protocolVersion, targetCount: targets.length, attachedTabs: this.tabs.size };
    } catch (error) {
      if (!(error instanceof CdpUnavailable) && !(error instanceof CdpError)) throw error;
      return { config, reachable: false, reason: error.message };
    }
  }

  async listPageTargets() {
    const client = await this.connection();
    const { targetInfos } = await client.send('Target.getTargets');
    return targetInfos
      .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
      .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title }));
  }

  /** Marker attribute of a target, or null. Used only by the tab mapper. */
  async readMarker(targetId) {
    const expression = `(document.documentElement && document.documentElement.getAttribute(${JSON.stringify(MARKER_ATTRIBUTE)})) || null`;
    try {
      const open = this.tabs.get(targetId);
      if (open) {
        const out = await open.session.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: MARKER_READ_TIMEOUT_MS });
        return out.result?.value ?? null;
      }
      const client = await this.connection();
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: MARKER_READ_TIMEOUT_MS });
      try {
        const out = await client.send('Runtime.evaluate', { expression, returnByValue: true }, { sessionId, timeoutMs: MARKER_READ_TIMEOUT_MS });
        return out.result?.value ?? null;
      } finally {
        client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    } catch {
      // A target that is gone, discarded or blocked by a dialog has no marker
      // we can read, which is the same answer as "not this one".
      return null;
    }
  }

  /**
   * Attach to a page target and start capturing from this moment. Idempotent:
   * a tab keeps one session, and with it one set of console and network buffers.
   */
  async attach(targetId, options = {}) {
    const existing = this.tabs.get(targetId);
    if (existing && !existing.closed) return existing;
    const client = await this.connection();
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true }, options);
    const session = client.session(sessionId);
    const tab = { targetId, sessionId, session, capture: new TabCapture(session), closed: false };
    this.tabs.set(targetId, tab);
    try {
      await Promise.all([
        session.send('Page.enable', {}, options),
        session.send('Runtime.enable', {}, options),
        session.send('Log.enable', {}, options),
        session.send('Network.enable', { maxTotalBufferSize: NETWORK_BUFFER_BYTES }, options)
      ]);
    } catch (error) {
      this.#dropTarget(targetId);
      client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      throw error;
    }
    return tab;
  }

  close() {
    this.#client?.close();
    this.#client = null;
    this.tabs.clear();
  }
}

export const engine = new CdpEngine();
