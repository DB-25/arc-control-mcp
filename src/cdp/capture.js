/**
 * Per-tab capture of console output, network activity and JavaScript dialogs.
 * It only sees what happens after the tab was first attached: CDP has no
 * history to ask for, so the tools say so rather than implying a full log.
 *
 * Nothing sensitive is ever held. Headers are redacted as they arrive, and
 * request or response bodies are never stored.
 */

export const MAX_CONSOLE_ENTRIES = 500;
export const MAX_NETWORK_ENTRIES = 500;
const MAX_TEXT_CHARS = 2000;
const REDACTED = '[redacted]';

// Credentials a page or its server put in a header. The pattern half catches
// the usual custom names (x-api-key, x-csrf-token, x-auth-user, x-session-id,
// x-signature, anything with token, secret or key in it) without listing them
// all. Over-matching is the safe direction: a redacted harmless header costs a
// glance, a leaked one costs a session.
const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$|^x-auth|session|signature|token|secret|key/i;

/** A copy of the headers with every credential-bearing value replaced. */
export function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = SENSITIVE_HEADER.test(name) ? REDACTED : value;
  }
  return out;
}

/** Fixed-size buffer that drops the oldest entry and counts what it dropped. */
export class Ring {
  #items = [];
  dropped = 0;
  constructor(max) {
    this.max = max;
  }
  push(item) {
    this.#items.push(item);
    if (this.#items.length > this.max) {
      this.#items.shift();
      this.dropped++;
    }
  }
  toArray() {
    return [...this.#items];
  }
  clear() {
    this.#items = [];
    this.dropped = 0;
  }
  get size() {
    return this.#items.length;
  }
}

const clip = (text) => (text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text);

/** Render one console argument the way DevTools would summarise it. */
export function formatRemoteObject(object) {
  if (!object) return '';
  if (object.value !== undefined) {
    return typeof object.value === 'string' ? object.value : JSON.stringify(object.value);
  }
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.type === 'undefined') return 'undefined';
  if (object.preview?.properties) {
    const props = object.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ');
    return `${object.className || object.subtype || 'Object'} {${props}${object.preview.overflow ? ', …' : ''}}`;
  }
  return object.description ?? `[${object.type}]`;
}

/**
 * A URL as network_requests shows it: never the fragment, and the query only on
 * request, since queries routinely carry tokens. A data: URL is the payload
 * itself, so only its scheme is kept.
 */
export function cleanUrl(url, { includeQuery = false } = {}) {
  const text = String(url ?? '');
  if (/^data:/i.test(text)) return 'data:\u2026';
  const noFragment = text.split('#')[0];
  return includeQuery ? noFragment : noFragment.split('?')[0];
}

const isoFromMs = (ms) => new Date(ms).toISOString();

/**
 * Subscribes to one tab session. `session` is the bound view from
 * CdpClient.session, so handlers only ever see this tab's events.
 */
export class TabCapture {
  console = new Ring(MAX_CONSOLE_ENTRIES);
  network = new Ring(MAX_NETWORK_ENTRIES);
  /** The dialog currently blocking the page, or null. */
  dialog = null;
  startedAt = new Date().toISOString();
  #inflight = new Map();
  #dialogWaiters = new Set();

  constructor(session) {
    this.session = session;
    session.on('Runtime.consoleAPICalled', (p) => this.#onConsole(p));
    session.on('Runtime.exceptionThrown', (p) => this.#onException(p));
    session.on('Log.entryAdded', (p) => this.#onLog(p));
    session.on('Network.requestWillBeSent', (p) => this.#onRequest(p));
    session.on('Network.responseReceived', (p) => this.#onResponse(p));
    session.on('Network.loadingFinished', (p) => this.#onFinished(p));
    session.on('Network.loadingFailed', (p) => this.#onFailed(p));
    session.on('Page.javascriptDialogOpening', (p) => this.#onDialogOpen(p));
    session.on('Page.javascriptDialogClosed', () => { this.dialog = null; });
  }

  /**
   * Resolves when a dialog opens. An action that triggers an alert() does not
   * return until the dialog is dismissed, so callers race against this to
   * report the dialog instead of hanging.
   */
  dialogWaiter() {
    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });
    const waiter = { resolve: resolveFn };
    this.#dialogWaiters.add(waiter);
    return { promise, dispose: () => this.#dialogWaiters.delete(waiter) };
  }

  #onDialogOpen(p) {
    this.dialog = {
      type: p.type,
      message: p.message,
      url: p.url,
      defaultPrompt: p.defaultPrompt,
      hasBrowserHandler: p.hasBrowserHandler
    };
    for (const waiter of [...this.#dialogWaiters]) waiter.resolve(this.dialog);
  }

  #onConsole(p) {
    const frame = p.stackTrace?.callFrames?.[0];
    this.console.push({
      level: p.type === 'warn' ? 'warning' : p.type,
      source: 'console-api',
      text: clip((p.args ?? []).map(formatRemoteObject).join(' ')),
      url: frame?.url || undefined,
      line: frame ? frame.lineNumber + 1 : undefined,
      at: isoFromMs(p.timestamp)
    });
  }

  #onException(p) {
    const d = p.exceptionDetails ?? {};
    this.console.push({
      level: 'error',
      source: 'exception',
      text: clip(d.exception?.description || d.text || 'Uncaught exception'),
      url: d.url || undefined,
      line: d.lineNumber !== undefined ? d.lineNumber + 1 : undefined,
      at: isoFromMs(p.timestamp)
    });
  }

  // The browser's own messages: failed loads, CSP and mixed-content blocks,
  // deprecations. Log reports "verbose" where the console API says "debug".
  #onLog(p) {
    const e = p.entry ?? {};
    this.console.push({
      level: e.level === 'verbose' ? 'debug' : e.level,
      source: e.source || 'log',
      text: clip(e.text ?? ''),
      url: e.url || undefined,
      line: e.lineNumber !== undefined ? e.lineNumber + 1 : undefined,
      at: isoFromMs(e.timestamp)
    });
  }

  #onRequest(p) {
    const previous = this.#inflight.get(p.requestId);
    // A redirect reuses the request id: the earlier hop is finished by its 3xx.
    if (previous && p.redirectResponse) {
      previous.status = p.redirectResponse.status;
      previous.durationMs = Math.round((p.timestamp - previous.mono) * 1000);
      previous.redirectedTo = p.request.url;
    }
    const entry = {
      id: p.requestId,
      method: p.request.method,
      url: p.request.url,
      type: p.type || 'Other',
      status: null,
      startedAt: isoFromMs((p.wallTime ?? Date.now() / 1000) * 1000),
      requestHeaders: redactHeaders(p.request.headers),
      mono: p.timestamp
    };
    this.#inflight.set(p.requestId, entry);
    this.network.push(entry);
  }

  #onResponse(p) {
    const entry = this.#inflight.get(p.requestId);
    if (!entry) return;
    entry.status = p.response.status;
    entry.statusText = p.response.statusText || undefined;
    entry.mimeType = p.response.mimeType;
    entry.fromCache = p.response.fromDiskCache || p.response.fromServiceWorker || undefined;
    entry.responseHeaders = redactHeaders(p.response.headers);
    if (p.type) entry.type = p.type;
  }

  #onFinished(p) {
    const entry = this.#inflight.get(p.requestId);
    if (!entry) return;
    entry.durationMs = Math.round((p.timestamp - entry.mono) * 1000);
    entry.encodedBytes = p.encodedDataLength;
    this.#inflight.delete(p.requestId);
  }

  #onFailed(p) {
    const entry = this.#inflight.get(p.requestId);
    if (!entry) return;
    entry.failed = true;
    entry.errorText = p.errorText;
    if (p.canceled) entry.canceled = true;
    entry.durationMs = Math.round((p.timestamp - entry.mono) * 1000);
    this.#inflight.delete(p.requestId);
  }

  readConsole({ level = 'all', limit = 100, clear = false } = {}) {
    const all = this.console.toArray();
    const matching = level === 'all' ? all : all.filter((e) => e.level === level);
    const entries = matching.slice(-limit);
    const result = { entries, total: matching.length, dropped: this.console.dropped };
    if (clear) this.console.clear();
    return result;
  }

  readNetwork({ urlContains, type, failedOnly = false, limit = 100, includeHeaders = false, includeQuery = false, clear = false } = {}) {
    const clean = (url) => cleanUrl(url, { includeQuery });
    let rows = this.network.toArray();
    // Matched against the url as it will be shown, so a filter cannot be used
    // to probe for a query string the caller was not given.
    if (urlContains) rows = rows.filter((r) => clean(r.url).includes(urlContains));
    if (type) rows = rows.filter((r) => r.type.toLowerCase() === type.toLowerCase());
    if (failedOnly) rows = rows.filter((r) => r.failed || (r.status !== null && r.status >= 400));
    const total = rows.length;
    const entries = rows.slice(-limit).map(({ mono, requestHeaders, responseHeaders, ...rest }) => ({
      ...rest,
      url: clean(rest.url),
      ...(rest.redirectedTo ? { redirectedTo: clean(rest.redirectedTo) } : {}),
      pending: rest.status === null && !rest.failed ? true : undefined,
      // Held redacted already; omitted unless asked for, to keep results small.
      ...(includeHeaders ? { requestHeaders, responseHeaders } : {})
    }));
    const result = { entries, total, dropped: this.network.dropped };
    if (clear) this.network.clear();
    return result;
  }
}
