// The pure parts of the CDP engine: capture buffers and redaction, key
// definitions, upload path validation, image sizing and result rendering.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TabCapture, redactHeaders, Ring, formatRemoteObject, MAX_CONSOLE_ENTRIES } from '../src/cdp/capture.js';
import { keyPressEvents, parseCombo, charEvents, MODIFIER_BITS } from '../src/cdp/keys.js';
import { validateUploadPaths, isSensitivePath, imageSize } from '../src/cdp/page-ops.js';
import { cdpScript } from '../src/cdp/tab.js';
import { toContent, omitImage } from '../src/result.js';

/** A session whose events the test fires by hand. */
function fakeSession() {
  const handlers = new Map();
  return {
    on(method, fn) { handlers.set(method, fn); },
    emit(method, params) { handlers.get(method)(params); }
  };
}

describe('header redaction', () => {
  it('redacts cookie, authorization and set-cookie in any case, and keeps the rest', () => {
    const out = redactHeaders({
      Cookie: 'sid=1', cookie: 'a', Authorization: 'Bearer x', 'Set-Cookie': 'sid=2', 'proxy-authorization': 'p',
      'X-Api-Key': 'k', 'x-csrf-token': 't', 'Content-Type': 'text/html', 'X-Custom': 'visible'
    });
    for (const name of ['Cookie', 'cookie', 'Authorization', 'Set-Cookie', 'proxy-authorization', 'X-Api-Key', 'x-csrf-token']) {
      assert.equal(out[name], '[redacted]', name);
    }
    assert.equal(out['Content-Type'], 'text/html');
    assert.equal(out['X-Custom'], 'visible');
  });

  it('also redacts x-auth, session, signature, token, secret and key names', () => {
    const names = ['X-Auth-User', 'x-authorization-extra', 'X-Session-Id', 'Session', 'x-amz-signature', 'X-Hub-Signature-256', 'X-Amz-Security-Token', 'x-shared-secret', 'X-Goog-Api-Key', 'Sec-WebSocket-Key', 'apikey'];
    const out = redactHeaders(Object.fromEntries(names.map((n) => [n, 'v'])));
    for (const name of names) assert.equal(out[name], '[redacted]', name);
    const kept = redactHeaders({ 'Content-Length': '1', Accept: '*/*', 'User-Agent': 'x', Host: 'a.test', 'Keep-Alive': 'timeout=5' });
    assert.ok(Object.values(kept).every((v) => v !== '[redacted]'), JSON.stringify(kept));
  });

  it('returns a new object and tolerates missing headers', () => {
    const input = { Cookie: 'x' };
    assert.notEqual(redactHeaders(input), input);
    assert.equal(input.Cookie, 'x');
    assert.deepEqual(redactHeaders(undefined), {});
  });
});

describe('Ring', () => {
  it('drops the oldest entries and counts them', () => {
    const ring = new Ring(3);
    [1, 2, 3, 4, 5].forEach((n) => ring.push(n));
    assert.deepEqual(ring.toArray(), [3, 4, 5]);
    assert.equal(ring.dropped, 2);
    ring.clear();
    assert.equal(ring.size, 0);
    assert.equal(ring.dropped, 0);
  });
});

describe('TabCapture console', () => {
  const stamp = 1_700_000_000_000;

  it('records console calls, exceptions and browser log entries with levels', () => {
    const s = fakeSession();
    const capture = new TabCapture(s);
    s.emit('Runtime.consoleAPICalled', {
      type: 'log', timestamp: stamp,
      args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 42 }, { type: 'object', className: 'Object', preview: { properties: [{ name: 'a', value: '1' }] } }],
      stackTrace: { callFrames: [{ url: 'https://a.test/app.js', lineNumber: 9 }] }
    });
    s.emit('Runtime.consoleAPICalled', { type: 'warn', timestamp: stamp, args: [{ type: 'string', value: 'careful' }] });
    s.emit('Runtime.exceptionThrown', { timestamp: stamp, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: nope' }, url: 'https://a.test/x.js', lineNumber: 2 } });
    s.emit('Log.entryAdded', { entry: { source: 'network', level: 'verbose', text: 'Failed to load resource', timestamp: stamp } });

    const { entries } = capture.readConsole();
    assert.equal(entries[0].text, 'hello 42 Object {a: 1}');
    assert.equal(entries[0].line, 10);
    assert.equal(entries[1].level, 'warning');
    assert.deepEqual([entries[2].level, entries[2].source, entries[2].text], ['error', 'exception', 'TypeError: nope']);
    assert.equal(entries[3].level, 'debug');
    assert.equal(capture.readConsole({ level: 'error' }).entries.length, 1);
  });

  it('limits to the newest entries, reports totals, and clears on request', () => {
    const s = fakeSession();
    const capture = new TabCapture(s);
    for (let i = 0; i < 5; i++) s.emit('Runtime.consoleAPICalled', { type: 'log', timestamp: 0, args: [{ type: 'number', value: i }] });
    const read = capture.readConsole({ limit: 2, clear: true });
    assert.deepEqual(read.entries.map((e) => e.text), ['3', '4']);
    assert.equal(read.total, 5);
    assert.equal(capture.readConsole().entries.length, 0);
  });

  it('is bounded', () => {
    const s = fakeSession();
    const capture = new TabCapture(s);
    for (let i = 0; i < MAX_CONSOLE_ENTRIES + 25; i++) s.emit('Runtime.consoleAPICalled', { type: 'log', timestamp: 0, args: [] });
    assert.equal(capture.console.size, MAX_CONSOLE_ENTRIES);
    assert.equal(capture.readConsole({ limit: 500 }).dropped, 25);
  });

  it('formats remote objects the way a person would read them', () => {
    assert.equal(formatRemoteObject({ type: 'undefined' }), 'undefined');
    assert.equal(formatRemoteObject({ type: 'number', unserializableValue: 'NaN' }), 'NaN');
    assert.equal(formatRemoteObject({ type: 'function', description: 'function f() {}' }), 'function f() {}');
    assert.equal(formatRemoteObject({ type: 'boolean', value: false }), 'false');
  });
});

describe('TabCapture network', () => {
  const request = (id, url, extra = {}) => ({ requestId: id, timestamp: 100, wallTime: 1_700_000_000, type: 'Fetch', request: { url, method: 'POST', headers: { Authorization: 'Bearer SECRET', Accept: '*/*' } }, ...extra });

  it('assembles a request from its events, with timing and size, and never stores a credential', () => {
    const s = fakeSession();
    const capture = new TabCapture(s);
    s.emit('Network.requestWillBeSent', request('1', 'https://a.test/api'));
    s.emit('Network.responseReceived', { requestId: '1', response: { status: 201, statusText: 'Created', mimeType: 'application/json', headers: { 'Set-Cookie': 'sid=SECRET', 'Content-Type': 'application/json' } } });
    s.emit('Network.loadingFinished', { requestId: '1', timestamp: 100.25, encodedDataLength: 321 });

    const [row] = capture.readNetwork().entries;
    assert.deepEqual([row.method, row.url, row.status, row.type, row.mimeType], ['POST', 'https://a.test/api', 201, 'Fetch', 'application/json']);
    assert.equal(row.durationMs, 250);
    assert.equal(row.encodedBytes, 321);
    assert.equal(row.requestHeaders, undefined, 'headers are opt-in');
    const withHeaders = JSON.stringify(capture.readNetwork({ includeHeaders: true }).entries);
    assert.ok(!withHeaders.includes('SECRET'), 'a credential reached the output');
    assert.match(withHeaders, /\[redacted\]/);
    assert.match(withHeaders, /application\/json/);
  });

  it('marks failures and filters by url, type and failure', () => {
    const s = fakeSession();
    const capture = new TabCapture(s);
    s.emit('Network.requestWillBeSent', request('1', 'https://a.test/ok', { type: 'Document' }));
    s.emit('Network.responseReceived', { requestId: '1', response: { status: 200, headers: {} } });
    s.emit('Network.requestWillBeSent', request('2', 'https://a.test/bad'));
    s.emit('Network.loadingFailed', { requestId: '2', timestamp: 100.1, errorText: 'net::ERR_CONNECTION_REFUSED' });
    s.emit('Network.requestWillBeSent', request('3', 'https://a.test/missing'));
    s.emit('Network.responseReceived', { requestId: '3', response: { status: 404, headers: {} } });
    s.emit('Network.requestWillBeSent', request('4', 'https://a.test/pending'));

    assert.equal(capture.readNetwork({ urlContains: 'ok' }).entries.length, 1);
    assert.equal(capture.readNetwork({ type: 'document' }).entries.length, 1);
    const failed = capture.readNetwork({ failedOnly: true }).entries;
    assert.deepEqual(failed.map((e) => e.url), ['https://a.test/bad', 'https://a.test/missing']);
    assert.equal(failed[0].errorText, 'net::ERR_CONNECTION_REFUSED');
    assert.equal(capture.readNetwork().entries.find((e) => e.url.endsWith('pending')).pending, true);
  });

  it('strips the query and fragment from urls unless include_query, and always the fragment', () => {
    const s = fakeSession();
    const capture = new TabCapture(s);
    s.emit('Network.requestWillBeSent', request('1', 'https://a.test/api?token=SECRET&x=1#frag'));
    s.emit('Network.requestWillBeSent', request('2', 'data:text/plain;base64,U0VDUkVU'));
    const plain = capture.readNetwork().entries;
    assert.equal(plain[0].url, 'https://a.test/api');
    assert.equal(plain[1].url, 'data:\u2026');
    assert.ok(!JSON.stringify(plain).includes('SECRET'));
    const withQuery = capture.readNetwork({ includeQuery: true }).entries;
    assert.equal(withQuery[0].url, 'https://a.test/api?token=SECRET&x=1');
  });

  it('url_contains cannot be used to probe for a query the caller was not given', () => {
    const s = fakeSession();
    const capture = new TabCapture(s);
    s.emit('Network.requestWillBeSent', request('1', 'https://a.test/api?token=SECRET'));
    assert.equal(capture.readNetwork({ urlContains: 'token=SECRET' }).entries.length, 0);
    assert.equal(capture.readNetwork({ urlContains: 'token=SECRET', includeQuery: true }).entries.length, 1);
    assert.equal(capture.readNetwork({ urlContains: '/api' }).entries.length, 1);
  });

  it('strips the query from the redirect target too', () => {
    const s = fakeSession();
    const capture = new TabCapture(s);
    s.emit('Network.requestWillBeSent', request('1', 'https://a.test/old'));
    s.emit('Network.requestWillBeSent', { ...request('1', 'https://a.test/new?code=SECRET'), redirectResponse: { status: 302 } });
    const [first] = capture.readNetwork().entries;
    assert.equal(first.redirectedTo, 'https://a.test/new');
  });

  it('records each redirect hop as its own request', () => {
    const s = fakeSession();
    const capture = new TabCapture(s);
    s.emit('Network.requestWillBeSent', request('1', 'https://a.test/old'));
    s.emit('Network.requestWillBeSent', request('1', 'https://a.test/new', { timestamp: 100.5, redirectResponse: { status: 302 } }));
    const rows = capture.readNetwork().entries;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 302);
    assert.equal(rows[0].redirectedTo, 'https://a.test/new');
  });
});

describe('TabCapture dialogs', () => {
  it('tracks the open dialog, wakes a waiter, and clears when it closes', async () => {
    const s = fakeSession();
    const capture = new TabCapture(s);
    const waiter = capture.dialogWaiter();
    assert.equal(capture.dialog, null);
    s.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'sure?', url: 'u', defaultPrompt: '', hasBrowserHandler: false });
    assert.equal((await waiter.promise).message, 'sure?');
    assert.equal(capture.dialog.type, 'confirm');
    s.emit('Page.javascriptDialogClosed', { result: true });
    assert.equal(capture.dialog, null);
    waiter.dispose();
  });
});

describe('key definitions', () => {
  it('Enter sends text, so a real form submission follows', () => {
    const [down, up] = keyPressEvents('Enter');
    assert.deepEqual([down.type, down.key, down.code, down.windowsVirtualKeyCode, down.text], ['keyDown', 'Enter', 'Enter', 13, '\r']);
    assert.equal(up.type, 'keyUp');
  });

  it('Tab has no text, so it is a raw key down that moves focus', () => {
    const [down] = keyPressEvents('Tab');
    assert.deepEqual([down.type, down.text, down.windowsVirtualKeyCode], ['rawKeyDown', undefined, 9]);
  });

  it('Meta+A is a shortcut: modifier events around it, no text, and the selectAll command', () => {
    const events = keyPressEvents('Meta+A');
    assert.deepEqual(events.map((e) => `${e.type}:${e.key}`), ['rawKeyDown:Meta', 'rawKeyDown:A', 'keyUp:A', 'keyUp:Meta']);
    const key = events[1];
    assert.equal(key.modifiers, MODIFIER_BITS.Meta);
    assert.equal(key.text, undefined);
    assert.deepEqual(key.commands, ['selectAll']);
    assert.equal(events[3].modifiers, 0, 'the modifier is released at the end');
  });

  it('Cmd and Command are Meta, and modifiers combine into one bitmask', () => {
    assert.equal(parseCombo('Cmd+Shift+Z').bits, MODIFIER_BITS.Meta | MODIFIER_BITS.Shift);
    assert.equal(parseCombo('Command+C').modifiers[0], 'Meta');
    assert.deepEqual(keyPressEvents('Meta+C')[1].commands, ['copy']);
  });

  it('Shift keeps its text (it is still typing), Control does not', () => {
    assert.equal(keyPressEvents('Shift+A')[1].text, 'A');
    assert.equal(keyPressEvents('Control+A')[1].text, undefined);
  });

  it('handles characters, digits, punctuation, the plus key, aliases and function keys', () => {
    assert.equal(charEvents('a')[0].code, 'KeyA');
    assert.equal(charEvents('A')[0].text, 'A');
    assert.equal(charEvents('7')[0].code, 'Digit7');
    assert.equal(charEvents('.')[0].code, 'Period');
    assert.equal(charEvents(' ')[0].code, 'Space');
    assert.equal(charEvents('\n')[0].key, 'Enter');
    assert.equal(keyPressEvents('+')[0].key, '+');
    assert.equal(keyPressEvents('Control++')[1].key, '+');
    assert.equal(keyPressEvents('esc')[0].key, 'Escape');
    assert.equal(keyPressEvents('F5')[0].windowsVirtualKeyCode, 116);
    assert.equal(charEvents('é')[0].text, 'é');
  });

  it('a bare modifier is a legitimate key press', () => {
    assert.equal(keyPressEvents('Shift')[0].key, 'Shift');
  });

  it('rejects unknown keys and modifiers with a message that says what is valid', () => {
    assert.throws(() => keyPressEvents('Flarp'), /Unknown key "Flarp"/);
    assert.throws(() => keyPressEvents('Hyper+A'), /Unknown modifier "Hyper"/);
    assert.throws(() => keyPressEvents(''), /A key is required/);
  });
});

describe('upload path validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arc-cdp-paths-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(join(home, 'Documents'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret');
  writeFileSync(join(home, 'Documents', 'ok.pdf'), 'pdf');
  writeFileSync(join(home, 'Documents', '.env'), 'KEY=1');
  symlinkSync(join(home, '.ssh', 'id_rsa'), join(home, 'Documents', 'innocent.txt'));
  const check = (paths) => validateUploadPaths(paths, { home });

  it('accepts an absolute path to a regular file', () => {
    assert.equal(check([join(home, 'Documents', 'ok.pdf')]).length, 1);
  });

  it('refuses relative paths, missing files, directories and an empty list', () => {
    assert.throws(() => check(['ok.pdf']), /not an absolute path/);
    assert.throws(() => check([join(home, 'nope.pdf')]), /does not exist/);
    assert.throws(() => check([join(home, 'Documents')]), /not a regular file/);
    assert.throws(() => check([]), /at least one/);
  });

  it('refuses credential locations, including through a symlink', () => {
    assert.throws(() => check([join(home, '.ssh', 'id_rsa')]), /browser-profile/);
    assert.throws(() => check([join(home, 'Documents', 'innocent.txt')]), /browser-profile/);
    assert.throws(() => check([join(home, 'Documents', '.env')]), /browser-profile/);
  });

  it('refuses env variants, shell history, mail, messages, Safari and browser profiles on disk', () => {
    const files = [
      ['.env.local'], ['.env.production'], ['.ENV.Staging'], ['.zsh_history'], ['.bash_history'],
      ['Library', 'Messages', 'chat.db'], ['Library', 'Mail', 'V10', 'Envelope Index'],
      ['Library', 'Safari', 'History.db'], ['Library', 'Keychains', 'login.keychain-db'],
      ['Library', 'Application Support', 'Arc', 'User Data', 'Default', 'Cookies'],
      ['Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Login Data']
    ];
    for (const parts of files) {
      mkdirSync(join(home, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(home, ...parts), 'x');
      assert.throws(() => check([join(home, ...parts)]), /browser-profile/, parts.join('/'));
    }
  });

  it('still accepts a file whose name only looks similar', () => {
    for (const name of ['environment.txt', 'my.env.txt', 'zsh_history_notes.md']) {
      writeFileSync(join(home, 'Documents', name), 'x');
      assert.equal(check([join(home, 'Documents', name)]).length, 1, name);
    }
  });

  it('cleans up', () => rmSync(dir, { recursive: true, force: true }));
});

describe('isSensitivePath compares case-insensitively, as a macOS volume does', () => {
  const homes = ['/Users/db'];

  it('refuses the same directory spelled in another case', () => {
    for (const path of ['/users/db/.ssh/id_rsa', '/USERS/DB/.SSH/id_ed25519', '/Users/db/library/keychains/login.keychain-db', '/users/db/Library/Application Support/arc/x']) {
      assert.equal(isSensitivePath(path, homes), true, path);
    }
  });

  it('refuses env variants and shell history under any case', () => {
    for (const path of ['/Users/db/app/.ENV', '/Users/db/app/.env.local', '/tmp/x/.Env.Production', '/Users/db/.ZSH_HISTORY', '/Users/db/.bash_history']) {
      assert.equal(isSensitivePath(path, homes), true, path);
    }
  });

  it('does not treat a sibling directory with a shared prefix as the sensitive one', () => {
    for (const path of ['/Users/db/.ssh-notes/readme.txt', '/Users/db/Library/MailTemplates/a.html', '/Users/db/Documents/.env-example.md']) {
      assert.equal(isSensitivePath(path, homes), false, path);
    }
  });
});

describe('imageSize', () => {
  it('reads PNG dimensions from the header', () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12);
    png.writeUInt32BE(800, 16);
    png.writeUInt32BE(600, 20);
    assert.deepEqual(imageSize(png.toString('base64'), 'png'), { width: 800, height: 600 });
  });

  it('reads JPEG dimensions from the start-of-frame segment', () => {
    // SOI, APP0 (length 4), SOF0 (height 300, width 400)
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03]);
    assert.deepEqual(imageSize(jpeg.toString('base64'), 'jpeg'), { width: 400, height: 300 });
  });

  it('returns null rather than guessing for garbage', () => {
    assert.equal(imageSize(Buffer.from('xx').toString('base64'), 'png'), null);
    assert.equal(imageSize(Buffer.from('not a jpeg at all really').toString('base64'), 'jpeg'), null);
  });
});

describe('page script isolation', () => {
  it('keeps the helper library inside a function so it cannot overwrite a page global named A', () => {
    const script = cdpScript('return 1;');
    assert.ok(script.startsWith('(function(){'));
    const sandbox = { A: 'the page owns this' };
    const result = new Function('sandbox', `with (sandbox) { return ${script}; }`)(sandbox);
    // The library needs a DOM only when used; envelope itself does not.
    assert.equal(result.v, 1);
    assert.equal(sandbox.A, 'the page owns this');
  });
});

describe('result rendering', () => {
  it('renders plain results as JSON text and images as image content, never base64 in the JSON', () => {
    assert.deepEqual(toContent({ ok: true }), [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }]);
    const content = toContent({ ok: true, width: 2, __image: { data: 'QUJD', mimeType: 'image/png' } });
    assert.equal(content.length, 2);
    assert.ok(!content[0].text.includes('QUJD'));
    assert.deepEqual(content[1], { type: 'image', data: 'QUJD', mimeType: 'image/png' });
  });

  it('batch drops the image and says so', () => {
    const out = omitImage({ ok: true, __image: { data: 'x', mimeType: 'image/png' } });
    assert.equal(out.__image, undefined);
    assert.match(out.imageOmitted, /batch/);
    assert.deepEqual(omitImage({ ok: true }), { ok: true });
    assert.equal(omitImage(null), null);
  });
});
