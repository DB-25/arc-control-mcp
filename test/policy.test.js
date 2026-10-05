// Guardrails are only worth having if they hold, so these test the policy with
// fake handlers and a fake tab resolver: no Arc, no osascript. The registry
// half (read-only advertising) runs the real registry in a child process,
// because the policy is read from the environment once at import.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parsePattern,
  loadPolicy,
  checkUrl,
  originOf,
  scrub,
  openAudit,
  createGuard,
  readOnlyRefusal
} from '../src/policy.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const policyFrom = (env) => loadPolicy(env);
const blockedBy = (env, url) => checkUrl(policyFrom(env), url);

describe('origin patterns', () => {
  it('matches a bare host on any scheme and port, and nothing that merely contains it', () => {
    const env = { ARC_MCP_ALLOWED_ORIGINS: 'example.com' };
    assert.equal(blockedBy(env, 'https://example.com/a?b=1'), null);
    assert.equal(blockedBy(env, 'http://example.com:8080/'), null);
    assert.ok(blockedBy(env, 'https://example.com.evil.test/'), 'a suffix trick must not pass');
    assert.ok(blockedBy(env, 'https://evil.test/example.com'), 'a path must not pass');
    assert.ok(blockedBy(env, 'https://sub.example.com/'), 'a bare host is not a wildcard');
  });

  it('wildcard covers subdomains only, so the apex has to be listed too', () => {
    const env = { ARC_MCP_ALLOWED_ORIGINS: '*.example.com' };
    assert.equal(blockedBy(env, 'https://a.example.com/'), null);
    assert.equal(blockedBy(env, 'https://a.b.example.com/'), null);
    assert.ok(blockedBy(env, 'https://example.com/'));
    assert.ok(blockedBy(env, 'https://badexample.com/'));
  });

  it('honours a scheme and a port when the entry names them', () => {
    const env = { ARC_MCP_ALLOWED_ORIGINS: 'https://example.com,localhost:3000' };
    assert.equal(blockedBy(env, 'https://example.com/'), null);
    assert.equal(blockedBy(env, 'https://example.com:443/'), null, 'the default port is still that port');
    assert.ok(blockedBy(env, 'http://example.com/'));
    assert.equal(blockedBy(env, 'http://localhost:3000/x'), null);
    assert.ok(blockedBy(env, 'http://localhost:4000/'));
  });

  it('names file: and about: by scheme', () => {
    const env = { ARC_MCP_ALLOWED_ORIGINS: 'file://,about:' };
    assert.equal(blockedBy(env, 'file:///tmp/a.html'), null);
    assert.equal(blockedBy(env, 'about:blank'), null);
    assert.ok(blockedBy(env, 'data:text/html,hi'));
    assert.ok(blockedBy({ ARC_MCP_ALLOWED_ORIGINS: 'example.com' }, 'file:///tmp/a.html'));
  });

  it('is case-insensitive on the host', () => {
    assert.equal(blockedBy({ ARC_MCP_ALLOWED_ORIGINS: 'Example.COM' }, 'https://EXAMPLE.com/'), null);
  });

  it('rejects an entry that is not an origin, at startup, naming the variable', () => {
    for (const bad of ['https://example.com/path', '*', '*.', 'exa mple.com', 'example.com:abc']) {
      assert.throws(
        () => policyFrom({ ARC_MCP_BLOCKED_ORIGINS: bad }),
        /ARC_MCP_BLOCKED_ORIGINS has an entry that is not an origin/,
        `"${bad}" should be refused`
      );
    }
  });

  it('parses a pattern into its parts', () => {
    assert.deepEqual(parsePattern('https://*.example.com:8443'), {
      raw: 'https://*.example.com:8443',
      scheme: 'https:',
      host: 'example.com',
      wildcard: true,
      port: '8443'
    });
  });
});

describe('allow and block lists together', () => {
  const env = { ARC_MCP_ALLOWED_ORIGINS: '*.example.com,example.com', ARC_MCP_BLOCKED_ORIGINS: 'admin.example.com' };

  it('lets a blocked rule win over an allowed one, and names the rule', () => {
    const violation = checkUrl(policyFrom(env), 'https://admin.example.com/');
    assert.equal(violation.rule, 'ARC_MCP_BLOCKED_ORIGINS');
    assert.equal(violation.entry, 'admin.example.com');
    assert.equal(checkUrl(policyFrom(env), 'https://www.example.com/'), null);
  });

  it('refuses an origin the allow list does not cover', () => {
    assert.equal(checkUrl(policyFrom(env), 'https://other.test/').rule, 'ARC_MCP_ALLOWED_ORIGINS');
  });

  it('refuses a blank or unparseable url under an allow list, but not under a block list alone', () => {
    assert.ok(checkUrl(policyFrom(env), ''));
    assert.ok(checkUrl(policyFrom(env), 'not a url'));
    assert.equal(checkUrl(policyFrom({ ARC_MCP_BLOCKED_ORIGINS: 'bank.test' }), ''), null);
  });

  it('keeps only the origin of a url, never the path or query', () => {
    assert.equal(originOf('https://example.com:8443/a/b?token=secret#frag'), 'https://example.com:8443');
    assert.equal(originOf('file:///Users/me/secret.html'), 'file://');
    assert.equal(originOf('data:text/html,secret'), 'data:');
  });
});

/** A fake tool shaped like a registry definition. */
const tool = (name, annotations) => ({ name, annotations: { title: name, ...annotations } });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const BOOKKEEPING = { ...WRITE, openWorldHint: false };

function harness(env, tabs = {}) {
  const calls = [];
  const resolved = [];
  const audit = [];
  const policy = policyFrom(env);
  const guard = createGuard(policy, {
    resolveTab: async (args, allowActive) => {
      resolved.push({ args, allowActive });
      const id = args.tab_id ?? 'own';
      if (!tabs[id]) throw new Error('TAB_NOT_FOUND');
      return { id, url: tabs[id] };
    },
    audit: (entry) => audit.push(entry),
    now: () => new Date('2026-10-05T12:00:00Z')
  });
  const wrap = (definition, result = { ok: true }) =>
    guard(definition, async (args) => {
      calls.push({ tool: definition.name, args });
      return typeof result === 'function' ? result(args) : result;
    });
  return { calls, resolved, audit, wrap };
}

describe('origin enforcement', () => {
  it('blocks a changing call on a blocked origin without running the handler', async () => {
    const h = harness({ ARC_MCP_BLOCKED_ORIGINS: '*.bank.test' }, { t1: 'https://www.bank.test/transfer' });
    const click = h.wrap(tool('click', WRITE));
    const result = await click({ tab_id: 't1', selector: '#go' });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.match(result.error, /ARC_MCP_BLOCKED_ORIGINS \(rule "\*\.bank\.test"\)/);
    assert.match(result.error, /https:\/\/www\.bank\.test/);
    assert.doesNotMatch(result.error, /transfer/, 'the path must not be echoed');
    assert.equal(h.calls.length, 0, 'the handler must not run');
  });

  it('runs the handler on an allowed origin, and pins the vetted tab when none was given', async () => {
    const h = harness({ ARC_MCP_ALLOWED_ORIGINS: 'example.com' }, { own: 'https://example.com/' });
    const fill = h.wrap(tool('fill', WRITE));
    const result = await fill({ selector: '#q', value: 'x' });
    assert.equal(result.ok, true);
    assert.equal(h.calls[0].args.tab_id, 'own', 'check and action must hit the same tab');
    assert.equal(h.resolved[0].allowActive, false, 'a changing tool never resolves to the active tab');
  });

  it('checks open_url by its target and does not look up a tab', async () => {
    const h = harness({ ARC_MCP_ALLOWED_ORIGINS: 'example.com' });
    const open = h.wrap(tool('open_url', WRITE), { ok: true, tab: { id: 'n', url: 'https://example.com/' } });
    const blocked = await open({ url: 'https://evil.test/?token=abc' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.rule, 'ARC_MCP_ALLOWED_ORIGINS');
    assert.match(blocked.error, /Nothing was opened/);
    assert.doesNotMatch(blocked.error, /token/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.resolved.length, 0);

    const allowed = await open({ url: 'https://example.com/ok' });
    assert.equal(allowed.ok, true);
  });

  it('reports a redirect that landed a navigation on a blocked origin as a failure', async () => {
    const h = harness({ ARC_MCP_BLOCKED_ORIGINS: 'evil.test' });
    const open = h.wrap(tool('open_url', WRITE), { ok: true, tab: { id: 'n', url: 'https://evil.test/landed' } });
    const result = await open({ url: 'https://example.com/redirects' });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.match(result.error, /redirect/);
  });

  it('leaves read tools alone by default, and gates them with ARC_MCP_BLOCK_READS', async () => {
    const tabs = { t1: 'https://www.bank.test/' };
    const open = harness({ ARC_MCP_BLOCKED_ORIGINS: 'www.bank.test' }, tabs);
    const read = open.wrap(tool('get_page_content', READ), { text: 'hi' });
    assert.deepEqual(await read({ tab_id: 't1' }), { text: 'hi' });
    assert.equal(open.resolved.length, 0, 'no lookup cost for a read nobody gates');

    const strict = harness({ ARC_MCP_BLOCKED_ORIGINS: 'www.bank.test', ARC_MCP_BLOCK_READS: '1' }, tabs);
    const gatedRead = strict.wrap(tool('get_page_content', READ), { text: 'hi' });
    const result = await gatedRead({ tab_id: 't1' });
    assert.equal(result.ok, false);
    assert.equal(strict.resolved[0].allowActive, true, 'a read may resolve to the active tab, as it will');
    assert.equal(strict.calls.length, 0);
  });

  it('vets a read that attaches a debugger like a changing tool, never the active tab', async () => {
    const h = harness({ ARC_MCP_BLOCKED_ORIGINS: 'www.bank.test', ARC_MCP_BLOCK_READS: '1' }, { own: 'https://example.com/' });
    const shot = h.wrap({ ...tool('screenshot', READ), ownTabOnly: true }, { ok: true });
    await shot({});
    assert.equal(h.resolved[0].allowActive, false);
    assert.equal(h.calls[0].args.tab_id, 'own', 'the vetted own tab is the one acted on');
  });

  it('does not gate Arc bookkeeping tools or batch itself', async () => {
    const h = harness({ ARC_MCP_ALLOWED_ORIGINS: 'example.com' }, {});
    const close = h.wrap(tool('close_tab', BOOKKEEPING));
    const batch = h.wrap(tool('batch', WRITE), { ok: true });
    assert.equal((await close({ tab_id: 'x' })).ok, true);
    assert.equal((await batch({ steps: [] })).ok, true);
    assert.equal(h.resolved.length, 0);
  });

  it('lets a tab-resolution failure propagate, since the handler would fail the same way', async () => {
    const h = harness({ ARC_MCP_BLOCKED_ORIGINS: 'bank.test' }, {});
    const click = h.wrap(tool('click', WRITE));
    await assert.rejects(() => click({ tab_id: 'gone' }), /TAB_NOT_FOUND/);
  });

  it('does nothing extra when no origin rule is set', async () => {
    const h = harness({}, {});
    const click = h.wrap(tool('click', WRITE));
    assert.equal((await click({ tab_id: 'any' })).ok, true);
    assert.equal(h.resolved.length, 0);
  });
});

describe('audit log', () => {
  it('records one entry per changing call with an origin, never a full url', async () => {
    const h = harness({ ARC_MCP_BLOCKED_ORIGINS: 'nowhere.test' }, { t1: 'https://example.com/private/path?k=v' });
    const click = h.wrap(tool('click', WRITE), { ok: true, tab: { id: 't1', url: 'https://example.com/private/path?k=v' } });
    await click({ tab_id: 't1', selector: '#go' });
    assert.equal(h.audit.length, 1);
    assert.deepEqual(h.audit[0], {
      time: '2026-10-05T12:00:00.000Z',
      tool: 'click',
      tab: 't1',
      origin: 'https://example.com',
      ok: true,
      error: null
    });
    assert.doesNotMatch(JSON.stringify(h.audit), /private|k=v/);
  });

  it('skips read tools and batch, whose steps are logged on their own', async () => {
    const h = harness({}, {});
    await h.wrap(tool('get_page_content', READ), { text: 'x' })({ tab_id: 't' });
    await h.wrap(tool('batch', WRITE), { ok: true })({ steps: [] });
    assert.equal(h.audit.length, 0);
  });

  it('logs a blocked call as a failure with the rule', async () => {
    const h = harness({ ARC_MCP_BLOCKED_ORIGINS: 'bank.test' }, { t1: 'https://bank.test/' });
    await h.wrap(tool('click', WRITE))({ tab_id: 't1' });
    assert.equal(h.audit[0].ok, false);
    assert.match(h.audit[0].error, /ARC_MCP_BLOCKED_ORIGINS/);
    assert.equal(h.audit[0].origin, 'https://bank.test');
  });

  it('logs a thrown error and rethrows it', async () => {
    const h = harness({}, {});
    const boom = h.wrap(tool('click', WRITE), () => {
      throw new Error('The page script failed: boom');
    });
    await assert.rejects(() => boom({ tab_id: 'x' }), /boom/);
    assert.equal(h.audit[0].ok, false);
    assert.equal(h.audit[0].tab, 'x');
  });

  it('never logs fill values, typed text, script code or urls, even when an error quotes them', async () => {
    const h = harness({}, {});
    const fill = h.wrap(tool('fill', WRITE), { ok: false, error: '<input> did not accept "hunter2-secret": its value is now ""' });
    await fill({ tab_id: 't', selector: '#pw', value: 'hunter2-secret' });
    const fillForm = h.wrap(tool('fill_form', WRITE), { ok: false, error: '1 field failed: bad "card-4242" ' });
    await fillForm({ tab_id: 't', fields: [{ selector: '#c', value: 'card-4242' }] });
    const run = h.wrap(tool('execute_javascript', WRITE), () => {
      throw new Error('The page script failed: ReferenceError: leakyName is not defined (in fetch("/api?key=abc123"))');
    });
    await assert.rejects(() => run({ tab_id: 't', code: 'fetch("/api?key=abc123"); leakyName' }));
    const open = h.wrap(tool('open_url', WRITE), () => {
      throw new Error('Not a valid URL: nope://x?token=zzz');
    });
    await assert.rejects(() => open({ url: 'nope://x?token=zzz' }));

    const text = JSON.stringify(h.audit);
    for (const secret of ['hunter2-secret', 'card-4242', 'abc123', 'token=zzz']) {
      assert.ok(!text.includes(secret), `the audit log leaked ${secret}`);
    }
    assert.equal(h.audit.length, 4);
    assert.match(h.audit[0].error, /details withheld/, 'a value tool says it failed, not why');
    assert.deepEqual(Object.keys(h.audit[0]).sort(), ['error', 'ok', 'origin', 'tab', 'time', 'tool']);
  });

  it('withholds the error of key presses and dialog answers, which can carry typed input', async () => {
    const h = harness({ ARC_MCP_AUDIT_LOG: '/dev/null' }, { t: 'https://example.com/' });
    for (const name of ['press_key', 'trusted_press_key', 'handle_dialog']) {
      const wrapped = h.wrap(tool(name, WRITE), { ok: false, error: 'Unknown key "hunter2" / prompt "pw-9" failed' });
      await wrapped({ tab_id: 't', key: 'hunter2', prompt_text: 'pw-9', action: 'accept' });
    }
    assert.equal(h.audit.length, 3);
    for (const entry of h.audit) assert.match(entry.error, /details withheld/, entry.tool);
    assert.ok(!JSON.stringify(h.audit).includes('hunter2'));
    assert.ok(!JSON.stringify(h.audit).includes('pw-9'));
  });

  it('scrub also removes key and prompt_text', () => {
    assert.equal(scrub('pressed Meta+Secret then typed pw-9', { key: 'Meta+Secret', prompt_text: 'pw-9' }), 'pressed [redacted] then typed [redacted]');
  });

  it('scrub removes every secret argument and caps the length', () => {
    assert.equal(scrub('typed abc into the box', { text: 'abc' }), 'typed [redacted] into the box');
    assert.ok(scrub('x'.repeat(1000), {}).length < 400);
  });
});

describe('audit file', () => {
  it('appends one JSON line per entry, owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc-audit-'));
    try {
      const path = join(dir, 'audit.jsonl');
      const write = openAudit(path);
      write({ tool: 'click', ok: true });
      write({ tool: 'fill', ok: false });
      const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(lines.map((l) => l.tool), ['click', 'fill']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op with no path, and a startup error for an unwritable one', () => {
    assert.doesNotThrow(() => openAudit(null)({ tool: 'x' }));
    assert.throws(() => openAudit('/nonexistent-dir-for-arc/audit.jsonl'), /ARC_MCP_AUDIT_LOG is not writable/);
  });
});

describe('read-only mode', () => {
  const run = (env, code) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: ROOT,
      env: { ...process.env, ARC_MCP_STATE_DIR: join(tmpdir(), 'arc-policy-test-state'), ...env },
      encoding: 'utf8'
    });

  it('advertises only the read tools and refuses a changing call by name', () => {
    const out = run(
      { ARC_MCP_READ_ONLY: '1' },
      `const m = await import('./src/registry.js');
       const refused = await m.HANDLERS.click({ selector: '#x' });
       console.log(JSON.stringify({ tools: m.TOOLS.map(t => [t.name, t.annotations.readOnlyHint]), refused }));`
    );
    assert.equal(out.status, 0, out.stderr);
    const { tools, refused } = JSON.parse(out.stdout);
    assert.ok(tools.length > 5);
    assert.ok(tools.every(([, readOnly]) => readOnly === true), 'a changing tool is still advertised');
    assert.ok(!tools.some(([name]) => ['click', 'fill', 'execute_javascript', 'batch', 'open_url', 'close_tab'].includes(name)));
    assert.deepEqual(refused, readOnlyRefusal('click'));
  });

  it('advertises everything when the flag is off', () => {
    const out = run({ ARC_MCP_READ_ONLY: '' }, `const m = await import('./src/registry.js'); console.log(m.TOOLS.length);`);
    assert.ok(Number(out.stdout) >= 26);
  });

  it('crashes at startup on a malformed rule, naming the variable', () => {
    const out = run({ ARC_MCP_ALLOWED_ORIGINS: 'https://x.test/path' }, `await import('./src/registry.js');`);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /ARC_MCP_ALLOWED_ORIGINS/);
  });

  it('writes an audit file only when asked, and creates it at startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc-audit-reg-'));
    try {
      const path = join(dir, 'a.jsonl');
      const out = run({ ARC_MCP_AUDIT_LOG: path }, `await import('./src/registry.js');`);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(existsSync(path), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
