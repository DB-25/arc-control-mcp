/**
 * A minimal Chrome DevTools Protocol client over the WebSocket that Node 22+
 * ships as a global. One connection to the browser endpoint carries every tab:
 * a "flat" session id on each message says which target it is for.
 *
 * Deliberately small. There is no reconnect and no protocol typing: the engine
 * owns lifecycle, and a command is just a method name and a params object.
 */

export const NEEDS_NODE_22 =
  'CDP tools need Node 22 or newer, which ships a global WebSocket. This server is running on ' +
  `Node ${process.versions.node}. Upgrade Node, then restart your MCP client.`;

export const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 5000;

export class CdpError extends Error {
  constructor(message, { code, method } = {}) {
    super(message);
    this.name = 'CdpError';
    // 'timeout' | 'cancelled' | 'closed' | a CDP numeric error code
    this.code = code;
    this.method = method;
  }
}

export const hasWebSocket = (impl = globalThis.WebSocket) => typeof impl === 'function';

export class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;
  #closeHandlers = new Set();

  /** Use CdpClient.connect. `ws` must already be open. */
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    ws.addEventListener('close', () => this.#onClose('The browser closed the DevTools connection.'));
    ws.addEventListener('error', () => this.#onClose('The DevTools connection failed.'));
  }

  static async connect(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
    if (!hasWebSocket(WebSocketImpl)) throw new CdpError(NEEDS_NODE_22, { code: 'no-websocket' });
    const ws = new WebSocketImpl(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* already dead */ }
        reject(new CdpError(`Timed out connecting to ${url} after ${timeoutMs}ms.`, { code: 'timeout' }));
      }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError(`Could not open a DevTools WebSocket at ${url}.`, { code: 'closed' }));
      }, { once: true });
    });
    return new CdpClient(ws);
  }

  get closed() {
    return this.#closed;
  }

  /**
   * Send a command and resolve with its result. A timeout or an aborted signal
   * rejects this call only: the connection stays usable, and a late reply for
   * an abandoned id is dropped.
   */
  send(method, params = {}, { sessionId, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, signal } = {}) {
    if (this.#closed) return Promise.reject(new CdpError('The DevTools connection is closed.', { code: 'closed', method }));
    if (signal?.aborted) return Promise.reject(new CdpError('Cancelled by the caller.', { code: 'cancelled', method }));

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let onAbort;
      const settle = (fn, value) => {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
        this.#pending.delete(id);
        fn(value);
      };
      const timer = setTimeout(
        () => settle(reject, new CdpError(`${method} did not answer within ${timeoutMs}ms.`, { code: 'timeout', method })),
        timeoutMs
      );
      if (signal) {
        onAbort = () => settle(reject, new CdpError('Cancelled by the caller.', { code: 'cancelled', method }));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending.set(id, {
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
        method
      });
      const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      try {
        this.#ws.send(JSON.stringify(message));
      } catch (error) {
        settle(reject, new CdpError(`Could not send ${method}: ${error.message}`, { code: 'closed', method }));
      }
    });
  }

  /** Subscribe to an event. The handler gets (params, sessionId). Returns an unsubscribe function. */
  on(method, handler) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(handler);
    return () => this.#listeners.get(method)?.delete(handler);
  }

  /** Resolve with the first matching event, or reject on timeout, abort or close. */
  waitFor(method, { sessionId, predicate = () => true, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, signal } = {}) {
    return new Promise((resolve, reject) => {
      let off;
      let offClose;
      const done = (fn, value) => {
        clearTimeout(timer);
        off?.();
        offClose?.();
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => done(reject, new CdpError('Cancelled by the caller.', { code: 'cancelled', method }));
      const timer = setTimeout(
        () => done(reject, new CdpError(`No ${method} event within ${timeoutMs}ms.`, { code: 'timeout', method })),
        timeoutMs
      );
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      off = this.on(method, (params, eventSession) => {
        if (sessionId && eventSession !== sessionId) return;
        if (predicate(params)) done(resolve, params);
      });
      offClose = this.onClose(() => done(reject, new CdpError('The DevTools connection closed.', { code: 'closed', method })));
    });
  }

  onClose(handler) {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  /** A view of the connection bound to one target session. */
  session(sessionId) {
    return {
      id: sessionId,
      send: (method, params, options = {}) => this.send(method, params, { ...options, sessionId }),
      on: (method, handler) => this.on(method, (params, from) => { if (from === sessionId) handler(params); }),
      waitFor: (method, options = {}) => this.waitFor(method, { ...options, sessionId })
    };
  }

  close() {
    this.#onClose('The DevTools connection was closed by this server.');
    try { this.#ws.close(); } catch { /* already closed */ }
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      // Not ours to interpret, and not worth failing every pending call over.
      console.error('arc-control: ignoring a malformed DevTools message');
      return;
    }
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      if (message.error) {
        entry.reject(new CdpError(`${entry.method} failed: ${message.error.message}`, { code: message.error.code, method: entry.method }));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (!message.method) return;
    for (const handler of [...(this.#listeners.get(message.method) ?? [])]) {
      try {
        handler(message.params ?? {}, message.sessionId);
      } catch (error) {
        console.error(`arc-control: a ${message.method} handler threw:`, error);
      }
    }
  }

  #onClose(reason) {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of [...this.#pending.values()]) {
      entry.reject(new CdpError(reason, { code: 'closed', method: entry.method }));
    }
    for (const handler of [...this.#closeHandlers]) handler();
  }
}
