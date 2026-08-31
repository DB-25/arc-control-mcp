import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Ownership is per process, never seeded from disk: two agents can share a
// label, and adopting the other one's tabs would let close_own_tabs close
// them. The file is keyed by session so a restarted agent can still find the
// tabs its dead predecessor leaked, and reap them on purpose (staleIds).
const STATE_DIR = process.env.ARC_MCP_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'arc-control-mcp');
const LABEL = process.env.ARC_MCP_LABEL || 'default';
const STATE_FILE = join(STATE_DIR, `${LABEL}.json`);
const LOCK_FILE = `${STATE_FILE}.lock`;
const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 5;

// pids get reused, so the start time keeps a restarted agent from being
// mistaken for its own previous session.
const SESSION_ID = `${process.pid}-${Math.round(Date.now() - process.uptime() * 1000)}`;

// How long a dead session's tab ids stay interesting. Long enough to survive a
// weekend of restarts, short enough that the file cannot grow forever.
const STALE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const AGENT_SPACE = process.env.ARC_MCP_SPACE || 'Agent';

const session = { owned: new Set(), currentTabId: null };

const pidOf = (sessionId) => Number.parseInt(String(sessionId).split('-')[0], 10);

// EPERM means the pid exists but belongs to someone else, which still counts
// as alive. Anything else (ESRCH, a malformed id) means gone.
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const isDeadSession = (sessionId) => sessionId !== SESSION_ID && !isAlive(pidOf(sessionId));

function readSessions() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
  if (raw && raw.sessions && typeof raw.sessions === 'object') return raw.sessions;
  // A file written by the flat pre-session format. Its ids belong to a run that
  // is certainly over, so present them as one dead session rather than losing
  // track of the tabs it left open.
  if (raw && Array.isArray(raw.owned)) {
    return { 'legacy-0': { owned: raw.owned, currentTabId: null, updatedAt: new Date().toISOString() } };
  }
  return {};
}

/** Dead sessions are kept only while they still name tabs worth reaping. */
function compact(sessions) {
  const cutoff = Date.now() - STALE_RETENTION_MS;
  const out = {};
  for (const [id, entry] of Object.entries(sessions)) {
    if (!isDeadSession(id)) {
      out[id] = entry;
      continue;
    }
    if (!entry.owned || entry.owned.length === 0) continue;
    const updatedAt = Date.parse(entry.updatedAt || '');
    if (Number.isFinite(updatedAt) && updatedAt < cutoff) continue;
    out[id] = entry;
  }
  return out;
}

function writeAtomic(sessions) {
  // Temp name carries the session id so two writers never share one, and the
  // rename means a crash mid-write cannot leave a half-written state file.
  const tmp = `${STATE_FILE}.${SESSION_ID}.tmp`;
  writeFileSync(tmp, JSON.stringify({ label: LABEL, sessions }, null, 2));
  renameSync(tmp, STATE_FILE);
}

// The state file is tiny, so a blocking wait costs microseconds and is much
// simpler than an async lock in code paths that are otherwise synchronous.
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Cross-process mutex. Without it, two agents reading and writing the same
 * file lose each other's updates: measured, one agent's tab vanished from disk
 * and stopped being reapable. `wx` fails when the lock exists, which is the
 * whole mechanism. A lock older than LOCK_WAIT_MS belonged to a crashed
 * process, so it is broken rather than left to wedge every later call.
 */
function withLock(fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  for (;;) {
    try {
      fd = openSync(LOCK_FILE, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) {
        rmSync(LOCK_FILE, { force: true });
        fd = openSync(LOCK_FILE, 'w');
        break;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(LOCK_FILE, { force: true });
  }
}

/**
 * Read-modify-write, so a sibling process sharing this label keeps its own
 * entry. `reaped` ids are also dropped from the dead sessions that listed
 * them, which is how a closed leaked tab stops being reported as stale.
 * A persistence failure is logged and swallowed: it must never fail a tool call.
 */
function persist(reaped) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    withLock(() => {
      const sessions = readSessions();
      sessions[SESSION_ID] = {
        owned: [...session.owned],
        currentTabId: session.currentTabId,
        updatedAt: new Date().toISOString()
      };
      if (reaped && reaped.size > 0) {
        for (const [id, entry] of Object.entries(sessions)) {
          if (id === SESSION_ID) continue;
          sessions[id] = { ...entry, owned: (entry.owned || []).filter((tabId) => !reaped.has(tabId)) };
        }
      }
      writeAtomic(compact(sessions));
    });
  } catch (error) {
    console.error('arc-control: could not persist state:', error.message);
  }
}

export function claim(tabId) {
  if (!tabId) return;
  session.owned.add(tabId);
  session.currentTabId = tabId;
  persist();
}

export function release(tabId) {
  session.owned.delete(tabId);
  if (session.currentTabId === tabId) {
    session.currentTabId = [...session.owned].pop() || null;
  }
  persist(new Set([tabId]));
}

export function focusOwn(tabId) {
  if (!session.owned.has(tabId)) return;
  session.currentTabId = tabId;
  persist();
}

export const ownedIds = () => [...session.owned];
export const currentTabId = () => session.currentTabId;
export const isOwned = (tabId) => session.owned.has(tabId);
export const label = () => LABEL;
export const sessionId = () => SESSION_ID;
export const stateFile = () => STATE_FILE;

/**
 * Tabs left behind by dead sessions of this label. Cleanup can reap these
 * deliberately; a live sibling's tabs are never in here.
 */
export function staleIds() {
  const out = new Set();
  for (const [id, entry] of Object.entries(readSessions())) {
    if (!isDeadSession(id)) continue;
    for (const tabId of entry.owned || []) {
      if (!session.owned.has(tabId)) out.add(tabId);
    }
  }
  return [...out];
}

/** Drop ids for tabs that no longer exist, so state does not grow forever. */
export function reconcile(liveIds) {
  const live = new Set(liveIds);
  let changed = false;
  for (const id of session.owned) {
    if (!live.has(id)) {
      session.owned.delete(id);
      changed = true;
    }
  }
  if (session.currentTabId && !live.has(session.currentTabId)) {
    session.currentTabId = [...session.owned].pop() || null;
    changed = true;
  }
  const vanished = new Set(staleIds().filter((id) => !live.has(id)));
  if (changed || vanished.size > 0) persist(vanished);
}
