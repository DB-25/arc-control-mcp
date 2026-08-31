// Tab ownership, the part that broke when two agents ran at once. Sharing a
// label used to mean adopting each other's tabs (so close_own_tabs could close
// a sibling's) and clobbering each other's writes (whoever wrote second dropped
// the first agent's tabs from disk, which stopped them being reapable).
//
// state.js reads its environment and its pid once, at import, so the
// cross-process half spawns real child processes. Everything is confined to a
// fresh temp directory via ARC_MCP_STATE_DIR, never the developer's real
// Application Support directory.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const STATE_MODULE = new URL('../src/state.js', import.meta.url).href;
const SPAWN_TIMEOUT_MS = 30000;

const temps = [];
function freshDir(prefix = 'arc-state-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// The child agent. It is generated at run time rather than kept as a file in
// test/, because `node --test test/` treats every .js file under test/ as a
// test file and would try to run a helper script as one.
const AGENT_SOURCE = `
const [stateUrl, ...tabs] = process.argv.slice(2);
const state = await import(stateUrl);
for (const id of tabs) state.claim(id);
process.stdout.write(JSON.stringify({
  pid: process.pid,
  sessionId: state.sessionId(),
  label: state.label(),
  stateFile: state.stateFile(),
  owned: state.ownedIds(),
  stale: state.staleIds(),
  currentTabId: state.currentTabId()
}) + '\\n');
// Signal readiness, then stay alive until the parent closes stdin, so a sibling
// can observe a session that is genuinely still running. Waiting on stdin
// instead of a sleep keeps the tests off the clock.
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;

const AGENT_DIR = freshDir('arc-agent-');
const AGENT_PATH = join(AGENT_DIR, 'agent.mjs');
writeFileSync(AGENT_PATH, AGENT_SOURCE);

/** Start a child agent. `ready` resolves with the snapshot it prints on stdout. */
function startAgent({ dir, label = 'shared', tabs = [] }) {
  const child = spawn(process.execPath, [AGENT_PATH, STATE_MODULE, ...tabs], {
    env: { ...process.env, ARC_MCP_STATE_DIR: dir, ARC_MCP_LABEL: label },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  // Attached now, so a fast exit cannot be missed later.
  const exited = once(child, 'exit');
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const end = stdout.indexOf('\n');
      if (end >= 0) resolve(JSON.parse(stdout.slice(0, end)));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`agent exited before signalling ready (code ${code}): ${stderr}`)));
  });

  return {
    ready,
    stop: () => {
      child.stdin.end();
      return exited;
    }
  };
}

const readState = (dir, label = 'shared') => JSON.parse(readFileSync(join(dir, `${label}.json`), 'utf8'));
const ownedOnDisk = (file) => Object.values(file.sessions).flatMap((entry) => entry.owned).sort();

// ---------------------------------------------------------------------------
// One session, in this process. The env has to be set before state.js is
// imported, since it reads ARC_MCP_* once at module load. `node --test` gives
// each test file its own process, so this cannot leak into another file.
// ---------------------------------------------------------------------------
const UNIT_DIR = freshDir('arc-state-unit-');
process.env.ARC_MCP_STATE_DIR = UNIT_DIR;
process.env.ARC_MCP_LABEL = 'unit-label';
process.env.ARC_MCP_SPACE = 'UnitSpace';
const state = await import(STATE_MODULE);

// A pid that cannot be running, for a session that is certainly over.
const DEAD_PID = 999999;

function resetSession() {
  for (const id of state.ownedIds()) state.release(id);
}

describe('state.js, one session in this process', () => {
  it('honours ARC_MCP_STATE_DIR, ARC_MCP_LABEL and ARC_MCP_SPACE', () => {
    assert.equal(state.label(), 'unit-label');
    assert.equal(state.stateFile(), join(UNIT_DIR, 'unit-label.json'));
    assert.equal(state.AGENT_SPACE, 'UnitSpace');
  });

  it('gives the session an id that carries this pid', () => {
    assert.match(state.sessionId(), /^\d+-\d+$/);
    assert.equal(state.sessionId().split('-')[0], String(process.pid));
  });

  it('claim records the tab, marks it current, and reports it as owned', () => {
    resetSession();
    state.claim('T1');
    state.claim('T2');
    assert.deepEqual(state.ownedIds(), ['T1', 'T2']);
    assert.equal(state.currentTabId(), 'T2');
    assert.equal(state.isOwned('T1'), true);
    assert.equal(state.isOwned('nope'), false);
  });

  it('claim ignores a missing tab id instead of owning undefined', () => {
    resetSession();
    state.claim(undefined);
    state.claim(null);
    state.claim('');
    assert.deepEqual(state.ownedIds(), []);
    assert.equal(state.currentTabId(), null);
  });

  it('release drops the tab and falls back to another owned tab', () => {
    resetSession();
    state.claim('T1');
    state.claim('T2');
    state.release('T2');
    assert.deepEqual(state.ownedIds(), ['T1']);
    assert.equal(state.currentTabId(), 'T1');
    state.release('T1');
    assert.deepEqual(state.ownedIds(), []);
    assert.equal(state.currentTabId(), null);
  });

  it('focusOwn follows a tab this session owns and ignores one it does not', () => {
    resetSession();
    state.claim('T1');
    state.claim('T2');
    state.focusOwn('T1');
    assert.equal(state.currentTabId(), 'T1');
    // A user tab must never become this agent's implicit target.
    state.focusOwn('USER-TAB');
    assert.equal(state.currentTabId(), 'T1');
  });

  it('reconcile forgets tabs that no longer exist in Arc', () => {
    resetSession();
    state.claim('T1');
    state.claim('T2');
    state.reconcile(['T1', 'SOMEONE-ELSE']);
    assert.deepEqual(state.ownedIds(), ['T1']);
    assert.equal(state.currentTabId(), 'T1');
  });

  it('writes a file keyed by session id, with the label alongside', () => {
    resetSession();
    state.claim('T9');
    const file = readState(UNIT_DIR, 'unit-label');
    assert.equal(file.label, 'unit-label');
    assert.deepEqual(Object.keys(file.sessions), [state.sessionId()]);
    assert.deepEqual(file.sessions[state.sessionId()].owned, ['T9']);
    assert.equal(file.sessions[state.sessionId()].currentTabId, 'T9');
    assert.match(file.sessions[state.sessionId()].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('never adopts tabs written by another session, and never drops them either', () => {
    // The file is a record of other sessions, not a seed for this one. Adopting
    // these would let close_own_tabs close tabs this agent never opened.
    resetSession();
    const foreign = `${DEAD_PID}-1700000000000`;
    writeFileSync(state.stateFile(), JSON.stringify({
      label: 'unit-label',
      sessions: { [foreign]: { owned: ['FOREIGN-1'], currentTabId: 'FOREIGN-1', updatedAt: new Date().toISOString() } }
    }));

    state.claim('MINE-1');
    assert.deepEqual(state.ownedIds(), ['MINE-1'], 'the foreign tab must not be adopted');

    const file = readState(UNIT_DIR, 'unit-label');
    assert.deepEqual(ownedOnDisk(file), ['FOREIGN-1', 'MINE-1'], 'the foreign tab must survive our write');
  });

  it('staleIds reports a dead session tabs and never this session own tabs', () => {
    resetSession();
    const foreign = `${DEAD_PID}-1700000000000`;
    writeFileSync(state.stateFile(), JSON.stringify({
      label: 'unit-label',
      sessions: { [foreign]: { owned: ['LEAKED-1', 'LEAKED-2'], currentTabId: null, updatedAt: new Date().toISOString() } }
    }));

    state.claim('MINE-1');
    assert.deepEqual(state.staleIds().sort(), ['LEAKED-1', 'LEAKED-2']);
    assert.ok(!state.staleIds().includes('MINE-1'));
  });

  it('reconcile clears stale ids for tabs that are gone from Arc as well', () => {
    resetSession();
    const foreign = `${DEAD_PID}-1700000000000`;
    writeFileSync(state.stateFile(), JSON.stringify({
      label: 'unit-label',
      sessions: { [foreign]: { owned: ['LEAKED-1', 'LEAKED-2'], currentTabId: null, updatedAt: new Date().toISOString() } }
    }));

    state.claim('MINE-1');
    // LEAKED-2 is still open in Arc, LEAKED-1 is not.
    state.reconcile(['MINE-1', 'LEAKED-2']);
    assert.deepEqual(state.staleIds(), ['LEAKED-2']);
  });

  it('never marks tabs from a pre-session flat file as reapable', () => {
    // Regression. The flat format carries no session identity, so a file that
    // looks like a finished run may equally belong to a server still running
    // the old code. Treating its ids as stale once marked two of the user's
    // live tabs for reaping, which include_stale would then have closed.
    resetSession();
    writeFileSync(state.stateFile(), JSON.stringify({ owned: ['OLD-1'], currentTabId: 'OLD-1' }));
    assert.deepEqual(state.staleIds(), [], 'a flat file must not make anything reapable');
    assert.deepEqual(state.ownedIds(), [], 'and must never be adopted as owned either');
  });

  it('leaves no lock file or temp file behind', () => {
    resetSession();
    state.claim('T1');
    const leftovers = readdirSync(UNIT_DIR).filter((name) => !name.endsWith('.json'));
    assert.deepEqual(leftovers, []);
    assert.equal(existsSync(`${state.stateFile()}.lock`), false);
  });
});

// ---------------------------------------------------------------------------
// Several sessions, in real processes.
// ---------------------------------------------------------------------------
describe('state.js across processes sharing a label', () => {
  it('each agent owns only the tabs it claimed, never a sibling ones', { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const dir = freshDir();
    const first = startAgent({ dir, tabs: ['A1', 'A2'] });
    const a = await first.ready;
    const second = startAgent({ dir, tabs: ['B1'] });
    const b = await second.ready;

    assert.deepEqual(a.owned.sort(), ['A1', 'A2']);
    assert.deepEqual(b.owned, ['B1']);
    assert.notEqual(a.sessionId, b.sessionId, 'two live agents must not share a session id');
    assert.equal(a.stateFile, b.stateFile, 'the same label means the same file');
    // Both are alive, so neither may see the other as a leak to reap.
    assert.deepEqual(a.stale, []);
    assert.deepEqual(b.stale, []);

    await Promise.all([first.stop(), second.stop()]);
  });

  it('the second agent write keeps the first agent tabs on disk', { timeout: SPAWN_TIMEOUT_MS }, async () => {
    // The lost-update regression, in its simplest sequential form: A writes,
    // then B writes, and A's tabs have to still be there afterwards.
    const dir = freshDir();
    const first = startAgent({ dir, tabs: ['A1', 'A2'] });
    await first.ready;
    const second = startAgent({ dir, tabs: ['B1'] });
    await second.ready;

    const file = readState(dir);
    assert.equal(Object.keys(file.sessions).length, 2, 'both sessions must be on disk');
    assert.deepEqual(ownedOnDisk(file), ['A1', 'A2', 'B1']);

    await Promise.all([first.stop(), second.stop()]);
  });

  it('four agents claiming at once all survive on disk', { timeout: SPAWN_TIMEOUT_MS }, async () => {
    // Unsequenced on purpose: the outcome is still exact, because the file lock
    // makes every claim a read-modify-write rather than a blind overwrite.
    const dir = freshDir();
    const ids = ['C1', 'C2', 'C3', 'C4'];
    const agents = ids.map((id) => startAgent({ dir, tabs: [id] }));
    const snapshots = await Promise.all(agents.map((agent) => agent.ready));

    for (const [index, snapshot] of snapshots.entries()) {
      assert.deepEqual(snapshot.owned, [ids[index]], 'no agent may pick up a sibling tab');
    }
    const file = readState(dir);
    assert.equal(Object.keys(file.sessions).length, 4);
    assert.deepEqual(ownedOnDisk(file), ids);

    await Promise.all(agents.map((agent) => agent.stop()));
  });

  it('a third agent started while the others are alive sees no owned and no stale tabs', { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const dir = freshDir();
    const first = startAgent({ dir, tabs: ['A1'] });
    await first.ready;
    const second = startAgent({ dir, tabs: ['B1'] });
    await second.ready;

    const third = startAgent({ dir });
    const c = await third.ready;
    assert.deepEqual(c.owned, [], 'a fresh session owns nothing');
    assert.deepEqual(c.stale, [], 'a live sibling tabs are not leaks to reap');
    assert.equal(c.currentTabId, null);

    await Promise.all([first.stop(), second.stop(), third.stop()]);
  });

  it('tabs from exited agents show up as stale, not as owned', { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const dir = freshDir();
    const first = startAgent({ dir, tabs: ['A1', 'A2'] });
    await first.ready;
    const second = startAgent({ dir, tabs: ['B1'] });
    await second.ready;
    // Both really gone before the next agent starts, so "dead" is a fact here
    // rather than a race.
    await Promise.all([first.stop(), second.stop()]);

    const later = startAgent({ dir });
    const d = await later.ready;
    assert.deepEqual(d.owned, []);
    assert.deepEqual(d.stale.sort(), ['A1', 'A2', 'B1']);

    await later.stop();
  });

  it('a different label is a different file, so labels do not interfere', { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const dir = freshDir();
    const shared = startAgent({ dir, label: 'shared', tabs: ['A1'] });
    await shared.ready;
    const other = startAgent({ dir, label: 'other', tabs: ['O1'] });
    const o = await other.ready;

    assert.equal(basename(o.stateFile), 'other.json');
    assert.deepEqual(ownedOnDisk(readState(dir, 'shared')), ['A1']);
    assert.deepEqual(ownedOnDisk(readState(dir, 'other')), ['O1']);
    assert.deepEqual(o.stale, [], 'another label tabs are not this label leaks');

    await Promise.all([shared.stop(), other.stop()]);
  });

  it('leaves no lock or temp files behind after concurrent writes', { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const dir = freshDir();
    const agents = ['D1', 'D2', 'D3'].map((id) => startAgent({ dir, tabs: [id] }));
    await Promise.all(agents.map((agent) => agent.ready));
    await Promise.all(agents.map((agent) => agent.stop()));

    assert.deepEqual(readdirSync(dir), ['shared.json']);
  });
});
