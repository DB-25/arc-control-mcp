// scripts/arc-cdp-healer.sh decides whether to quit and relaunch Arc, so its
// decisions are tested here against stub pgrep, ps, curl, osascript and open on
// a private PATH. Nothing touches a real Arc.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/arc-cdp-healer.sh', import.meta.url));
const PLIST = fileURLToPath(new URL('../scripts/company.thebrowser.arc-cdp-healer.plist.template', import.meta.url));

let root, bin, home;

const stub = (name, body) => {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'arc-healer-'));
  bin = join(root, 'bin');
  home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const calls = join(root, 'calls');
  stub('pgrep', `[ -f "${root}/quit" ] && exit 1; [ "\${STUB_ARC_RUNNING:-1}" = 1 ] && echo 4242 || exit 1`);
  stub('ps', 'echo "${STUB_ETIME:-00:30}"');
  stub('curl', 'echo "curl $*" >> "' + calls + '"; exit "${STUB_CURL_EXIT:-7}"');
  stub('osascript', `echo "osascript $*" >> "${calls}"; [ "\${STUB_QUIT_WORKS:-1}" = 1 ] && touch "${root}/quit"; exit 0`);
  stub('open', `echo "open $*" >> "${calls}"`);
  // The real ioreg would make these tests depend on whoever is at the keyboard.
  stub('ioreg', 'echo "    | |   \\"HIDIdleTime\\" = ${STUB_IDLE_NS:-60000000000}"');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(env = {}) {
  rmSync(join(root, 'quit'), { force: true });
  execFileSync('/bin/bash', [SCRIPT], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ARC_CDP_HEALER_QUIT_WAIT_SECONDS: '1', ...env },
    stdio: 'pipe'
  });
  const calls = existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').split('\n').filter(Boolean) : [];
  const logFile = join(home, 'Library', 'Logs', 'arc-cdp-healer.log');
  return { calls: calls.filter((c) => !c.startsWith('curl')), curl: calls.filter((c) => c.startsWith('curl')), log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' };
}

describe('arc-cdp-healer.sh', () => {
  it('does nothing when Arc is not running', () => {
    const out = run({ STUB_ARC_RUNNING: '0' });
    assert.deepEqual(out.calls, []);
    assert.equal(out.log, '');
  });

  it('does nothing when the DevTools port already answers', () => {
    const out = run({ STUB_CURL_EXIT: '0', STUB_ETIME: '00:10' });
    assert.deepEqual(out.calls, []);
    assert.match(out.curl[0], /127\.0\.0\.1:9222\/json\/version/);
  });

  it('does nothing to an Arc that has been running a while, so it never interrupts a session', () => {
    for (const etime of ['03:00', '05:12', '02:00:00', '3-04:05:06']) {
      assert.deepEqual(run({ STUB_ETIME: etime }).calls, [], `etime ${etime}`);
    }
  });

  it('treats 179 seconds as fresh and 180 as a session in use', () => {
    assert.equal(run({ STUB_ETIME: '02:59', ARC_CDP_HEALER_STATE: join(root, 's1') }).calls.length, 2);
    rmSync(join(root, 'calls'));
    assert.equal(run({ STUB_ETIME: '03:00', ARC_CDP_HEALER_STATE: join(root, 's2') }).calls.length, 0);
  });

  it('quits a just-started Arc gracefully and reopens it with the flag, in that order', () => {
    const out = run({ STUB_ETIME: '00:12' });
    assert.equal(out.calls.length, 2, out.calls.join('\n'));
    assert.match(out.calls[0], /^osascript -e tell application "Arc" to quit$/);
    assert.equal(out.calls[1], 'open -a Arc --args --remote-debugging-port=9222');
    assert.match(out.log, /quitting it gracefully/);
    assert.match(out.log, /reopened Arc/);
  });

  it('uses ARC_MCP_CDP_PORT for both the probe and the flag', () => {
    const out = run({ STUB_ETIME: '00:12', ARC_MCP_CDP_PORT: '9333' });
    assert.match(out.curl[0], /127\.0\.0\.1:9333\//);
    assert.equal(out.calls[1], 'open -a Arc --args --remote-debugging-port=9333');
  });

  it('does not repeat within the cooldown, so an Arc that ignores the flag is not quit in a loop', () => {
    const first = run({ STUB_ETIME: '00:12' });
    assert.equal(first.calls.length, 2);
    // Fresh the second time too (as it would be after the relaunch), but already tried.
    rmSync(join(root, 'calls'));
    const second = run({ STUB_ETIME: '00:12' });
    assert.deepEqual(second.calls, []);
    assert.match(second.log, /already tried/);
    assert.match(second.log, /--check-cdp/);
  });

  it('a dry run logs the decision and changes nothing', () => {
    const out = run({ STUB_ETIME: '00:12', ARC_CDP_HEALER_DRY_RUN: '1' });
    assert.deepEqual(out.calls, []);
    assert.match(out.log, /dry run: would quit Arc/);
  });

  it('never force-kills: if Arc does not quit it is left running and nothing is reopened', () => {
    const out = run({ STUB_ETIME: '00:12', STUB_QUIT_WORKS: '0' });
    assert.equal(out.calls.length, 1);
    assert.match(out.calls[0], /^osascript/);
    assert.match(out.log, /gave up: Arc did not quit/);
  });

  it('is valid bash and the plist template is valid XML with its placeholders', () => {
    execFileSync('/bin/bash', ['-n', SCRIPT]);
    const plist = readFileSync(PLIST, 'utf8');
    assert.match(plist, /<string>company\.thebrowser\.arc-cdp-healer<\/string>/);
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>30<\/integer>/);
    assert.ok(plist.includes('__SCRIPT_PATH__') && plist.includes('__HOME__'));
  });

  it('never quits Arc while the user is typing or moving the mouse', () => {
    const result = run({ STUB_IDLE_NS: '800000000', ARC_CDP_HEALER_STATE: join(root, 's-active') });
    assert.deepEqual(result.calls.filter((c) => c.startsWith('osascript') || c.startsWith('open')), []);
  });
});
