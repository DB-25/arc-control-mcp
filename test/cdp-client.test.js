// The CDP client's framing, timeouts and cancellation, against a fake WebSocket.
// Nothing here opens a socket or a browser.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CdpClient, CdpError, NEEDS_NODE_22 } from '../src/cdp/client.js';

class FakeWS {
  static last = null;
  sent = [];
  #listeners = {};
  constructor(url) {
    this.url = url;
    FakeWS.last = this;
    queueMicrotask(() => this.emit('open'));
  }
  addEventListener(type, fn, options) {
    (this.#listeners[type] ??= []).push({ fn, once: options?.once });
  }
  emit(type, event = {}) {
    for (const entry of [...(this.#listeners[type] ?? [])]) {
      if (entry.once) this.#listeners[type] = this.#listeners[type].filter((e) => e !== entry);
      entry.fn(event);
    }
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.emit('close'); }
  receive(message) { this.emit('message', { data: typeof message === 'string' ? message : JSON.stringify(message) }); }
}

const connect = () => CdpClient.connect('ws://127.0.0.1:1/devtools/browser/x', { WebSocketImpl: FakeWS });

describe('CdpClient framing', () => {
  it('sends numbered JSON commands and resolves with the matching result', async () => {
    const client = await connect();
    const ws = FakeWS.last;
    const first = client.send('Page.enable');
    const second = client.send('Runtime.evaluate', { expression: '1' });
    assert.deepEqual(ws.sent[0], { id: 1, method: 'Page.enable', params: {} });
    assert.deepEqual(ws.sent[1], { id: 2, method: 'Runtime.evaluate', params: { expression: '1' } });
    // Answered out of order: ids, not arrival order, decide who gets what.
    ws.receive({ id: 2, result: { v: 'second' } });
    ws.receive({ id: 1, result: { v: 'first' } });
    assert.deepEqual(await first, { v: 'first' });
    assert.deepEqual(await second, { v: 'second' });
  });

  it('puts the session id on the frame for a session-scoped command', async () => {
    const client = await connect();
    const ws = FakeWS.last;
    const pending = client.session('S1').send('DOM.enable');
    assert.equal(ws.sent[0].sessionId, 'S1');
    ws.receive({ id: 1, result: {} });
    await pending;
  });

  it('rejects with the protocol message and code when the browser reports an error', async () => {
    const client = await connect();
    const pending = client.send('Page.nope');
    FakeWS.last.receive({ id: 1, error: { code: -32601, message: "'Page.nope' wasn't found" } });
    await assert.rejects(pending, (error) => error instanceof CdpError && error.code === -32601 && /wasn't found/.test(error.message));
  });

  it('ignores a malformed frame without failing the commands in flight', async () => {
    const client = await connect();
    const pending = client.send('Page.enable');
    FakeWS.last.receive('{not json');
    FakeWS.last.receive({ id: 1, result: { ok: true } });
    assert.deepEqual(await pending, { ok: true });
  });
});

describe('CdpClient timeouts and cancellation', () => {
  it('rejects one call on timeout, leaves the connection usable, and drops a late reply', async () => {
    const client = await connect();
    const ws = FakeWS.last;
    await assert.rejects(client.send('Slow.thing', {}, { timeoutMs: 15 }), (e) => e.code === 'timeout' && /Slow\.thing/.test(e.message));
    ws.receive({ id: 1, result: { late: true } }); // must not throw or resolve anything
    const next = client.send('Fast.thing');
    ws.receive({ id: 2, result: { fine: true } });
    assert.deepEqual(await next, { fine: true });
  });

  it('rejects as cancelled when the signal aborts, and never sends if it already had', async () => {
    const client = await connect();
    const ws = FakeWS.last;
    const controller = new AbortController();
    const pending = client.send('Page.captureScreenshot', {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (e) => e.code === 'cancelled');

    const before = ws.sent.length;
    await assert.rejects(client.send('Page.enable', {}, { signal: controller.signal }), (e) => e.code === 'cancelled');
    assert.equal(ws.sent.length, before, 'an already-aborted call must not reach the browser');
  });

  it('fails every pending call as closed when the socket drops, and refuses new ones', async () => {
    const client = await connect();
    const a = client.send('A');
    const b = client.send('B');
    FakeWS.last.emit('close');
    await assert.rejects(a, (e) => e.code === 'closed');
    await assert.rejects(b, (e) => e.code === 'closed');
    assert.equal(client.closed, true);
    await assert.rejects(client.send('C'), (e) => e.code === 'closed');
  });

  it('close() is clean and idempotent', async () => {
    const client = await connect();
    let notified = 0;
    client.onClose(() => notified++);
    client.close();
    client.close();
    assert.equal(notified, 1);
  });
});

describe('CdpClient events and sessions', () => {
  it('delivers events with their session id, and a session view only sees its own', async () => {
    const client = await connect();
    const ws = FakeWS.last;
    const all = [];
    const mine = [];
    client.on('Network.requestWillBeSent', (params, sessionId) => all.push([params.n, sessionId]));
    client.session('S1').on('Network.requestWillBeSent', (params) => mine.push(params.n));
    ws.receive({ method: 'Network.requestWillBeSent', params: { n: 1 }, sessionId: 'S1' });
    ws.receive({ method: 'Network.requestWillBeSent', params: { n: 2 }, sessionId: 'S2' });
    assert.deepEqual(all, [[1, 'S1'], [2, 'S2']]);
    assert.deepEqual(mine, [1]);
  });

  it('keeps delivering when one handler throws', async () => {
    const client = await connect();
    const seen = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      client.on('X.y', () => { throw new Error('bad handler'); });
      client.on('X.y', () => seen.push('second'));
      FakeWS.last.receive({ method: 'X.y', params: {} });
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(seen, ['second']);
  });

  it('waitFor resolves on the first match, and times out otherwise', async () => {
    const client = await connect();
    const ws = FakeWS.last;
    const waiting = client.waitFor('Page.loadEventFired', { predicate: (p) => p.ok === true, timeoutMs: 500 });
    ws.receive({ method: 'Page.loadEventFired', params: { ok: false } });
    ws.receive({ method: 'Page.loadEventFired', params: { ok: true } });
    assert.deepEqual(await waiting, { ok: true });
    await assert.rejects(client.waitFor('Never.happens', { timeoutMs: 10 }), (e) => e.code === 'timeout');
  });

  it('an unsubscribed handler stops receiving', async () => {
    const client = await connect();
    let count = 0;
    const off = client.on('A.b', () => count++);
    FakeWS.last.receive({ method: 'A.b', params: {} });
    off();
    FakeWS.last.receive({ method: 'A.b', params: {} });
    assert.equal(count, 1);
  });
});

describe('CdpClient without a WebSocket', () => {
  it('says it needs Node 22 or newer', async () => {
    await assert.rejects(CdpClient.connect('ws://x', { WebSocketImpl: null }), (e) => e.message === NEEDS_NODE_22 && /Node 22/.test(e.message));
  });

  it('reports a connection that never opens as a timeout', async () => {
    class Silent { addEventListener() {} close() {} }
    await assert.rejects(CdpClient.connect('ws://x', { WebSocketImpl: Silent, timeoutMs: 15 }), (e) => e.code === 'timeout');
  });
});
