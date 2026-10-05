// The recorder runs in the page, so most of it is proven against real Arc in
// the integration tests. What can be proven here is the recorder's own logic:
// it is evaluated in a vm sandbox with stand-ins for the page's globals, so
// the promises that matter are checked without a browser. Those are that it
// records method, url, status and duration, never a body or a header, never a
// query unless asked, and passes every call through unchanged.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { TOOLS } from '../src/registry.js';
import { pageScript } from '../src/page-lib.js';
import { mainWorldSource, installScript, readScript } from '../src/tools/capture.js';

const CHANNEL = 'arc-cap-test';

function sandbox({ fetchImpl } = {}) {
  const events = [];
  const attrs = new Map();
  const listeners = { window: {} };
  const sent = [];
  class FakeXhr {
    open(...args) { this.openArgs = args; }
    send(body) { sent.push(body); }
    addEventListener(type, fn) { (this.handlers ||= {})[type] = fn; }
  }
  const context = {
    URL,
    JSON,
    WeakMap,
    Error,
    String,
    Math,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    location: { href: 'https://page.test/app/' },
    performance: { now: () => 1234.4 },
    console: { calls: [], log(...a) { this.calls.push(['log', a]); }, info() {}, warn() {}, error() {}, debug() {} },
    document: {
      documentElement: {
        getAttribute: (name) => attrs.get(name) ?? null,
        setAttribute: (name, value) => attrs.set(name, value)
      },
      dispatchEvent: (event) => { events.push(JSON.parse(event.detail)); return true; }
    },
    XMLHttpRequest: FakeXhr,
    fetch: fetchImpl ?? (async () => ({ status: 200, ok: true, json: async () => ({ secret: 'body' }) }))
  };
  context.window = context;
  context.window.addEventListener = (type, fn) => { listeners.window[type] = fn; };
  vm.createContext(context);
  return { context, events, attrs, listeners, sent, FakeXhr };
}

const install = (box, strip = true) => vm.runInContext(mainWorldSource(CHANNEL, strip), box.context);

describe('the main-world recorder', () => {
  it('parses, and stamps the document so the installer can tell it ran', () => {
    const box = sandbox();
    install(box);
    assert.equal(box.attrs.get('data-arc-capture'), CHANNEL);
  });

  it('is a no-op the second time on the same document', () => {
    const box = sandbox();
    install(box);
    const wrapped = box.context.fetch;
    install(box);
    assert.equal(box.context.fetch, wrapped, 'a second install must not wrap fetch twice');
  });

  it('records console output and still calls the real console', () => {
    const box = sandbox();
    const realLog = box.context.console.log;
    install(box);
    box.context.console.log('hello', { a: 1 }, new Error('boom'));
    assert.deepEqual(box.events[0], { type: 'console', level: 'log', text: 'hello {"a":1} Error: boom', t: 1234 });
    assert.equal(realLog === box.context.console.log, false, 'console.log is wrapped');
  });

  it('records fetch method, url, status and duration, strips the query and fragment, and returns the original response', async () => {
    const response = { status: 201, ok: true, body: 'untouched' };
    const box = sandbox({ fetchImpl: async () => response });
    install(box);
    const got = await box.context.fetch('/api/items?token=SECRET#frag', { method: 'post', headers: { Authorization: 'Bearer SECRET' }, body: 'payload-SECRET' });
    assert.equal(got, response, 'the caller gets the very response the page would have');
    const [event] = box.events;
    assert.equal(event.type, 'fetch');
    assert.equal(event.method, 'POST');
    assert.equal(event.url, 'https://page.test/api/items');
    assert.equal(event.query, true);
    assert.equal(event.status, 201);
    assert.equal(typeof event.ms, 'number');
    assert.ok(!JSON.stringify(event).includes('SECRET'), 'no query, header or body value may reach the buffer');
    assert.deepEqual(Object.keys(event).sort(), ['method', 'ms', 'ok', 'query', 'status', 't', 'type', 'url']);
  });

  it('keeps the query only when asked', async () => {
    const box = sandbox();
    install(box, false);
    await box.context.fetch('https://x.test/a?q=1#h');
    assert.equal(box.events[0].url, 'https://x.test/a?q=1');
  });

  it('reduces a data: url to its scheme, since the url is the payload', async () => {
    const box = sandbox();
    install(box);
    await box.context.fetch('data:text/plain,secret-payload');
    assert.ok(!JSON.stringify(box.events).includes('secret-payload'));
  });

  it('records a rejected fetch and rethrows the same error', async () => {
    const failure = new TypeError('Failed to fetch');
    const box = sandbox({ fetchImpl: async () => { throw failure; } });
    install(box);
    await assert.rejects(() => box.context.fetch('https://down.test/'), (error) => error === failure);
    assert.equal(box.events[0].error, 'TypeError: Failed to fetch');
    assert.equal(box.events[0].status, undefined);
  });

  it('records XMLHttpRequest on loadend, status 0 included, and still sends', () => {
    const box = sandbox();
    install(box);
    const xhr = new box.FakeXhr();
    xhr.open('get', '/x?k=SECRET');
    xhr.send('body-SECRET');
    assert.deepEqual(box.sent, ['body-SECRET'], 'the request is still sent, unchanged');
    xhr.status = 0;
    xhr.handlers.loadend();
    const [event] = box.events;
    assert.equal(event.type, 'xhr');
    assert.equal(event.method, 'GET');
    assert.equal(event.status, 0);
    assert.equal(event.ok, false);
    assert.ok(!JSON.stringify(event).includes('SECRET'));
  });

  it('records uncaught errors, resource load failures and unhandled rejections', () => {
    const box = sandbox();
    install(box);
    box.listeners.window.error({ message: 'x is not defined', filename: 'https://page.test/app.js?v=SECRET', lineno: 3, colno: 9, target: box.context });
    box.listeners.window.error({ target: { tagName: 'IMG', src: 'https://page.test/missing.png' } });
    box.listeners.window.unhandledrejection({ reason: new RangeError('nope') });
    assert.deepEqual(box.events.map((e) => e.type), ['error', 'resource-error', 'unhandledrejection']);
    assert.equal(box.events[0].source, 'https://page.test/app.js');
    assert.equal(box.events[1].tag, 'img');
    assert.equal(box.events[2].reason, 'RangeError: nope');
  });

  it('caps a long console message', () => {
    const box = sandbox();
    install(box);
    box.context.console.log('x'.repeat(5000));
    assert.ok(box.events[0].text.length <= 501);
  });
});

describe('the isolated-world scripts', () => {
  it('parse, in every variant', () => {
    for (const body of [installScript('c', true), installScript('c', false), readScript({}), readScript({ kind: 'network', max: 5, clear: true })]) {
      assert.doesNotThrow(() => new vm.Script(pageScript(body)));
    }
  });

  it('the install script reports a blocked injection rather than claiming success', () => {
    assert.match(installScript('c', true), /installed: false/);
    assert.match(installScript('c', true), /Content-Security-Policy/);
  });
});

describe('capture tool surface', () => {
  const byName = (name) => TOOLS.find((tool) => tool.name === name);

  it('capture_start changes the page, the readers do not', () => {
    assert.equal(byName('capture_start').annotations.readOnlyHint, false);
    assert.equal(byName('capture_read').annotations.readOnlyHint, true);
    assert.equal(byName('network_entries').annotations.readOnlyHint, true);
  });

  it('bounds how much one read can return', () => {
    assert.equal(byName('capture_read').inputSchema.properties.max.maximum, 500);
    assert.equal(byName('network_entries').inputSchema.properties.limit.maximum, 500);
  });

  it('says in its description that bodies and headers are never recorded', () => {
    assert.match(byName('capture_start').description, /Bodies and headers are never recorded/);
  });
});
