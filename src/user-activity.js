import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Anything that creates a window or a tab, or that moves keyboard focus, can
// land in the middle of what the user is typing. The gate holds those back
// until the Mac has been quiet for a moment. Pure background work (scripting
// an already-open tab, reading it) never touches the screen and never waits.

export const DEFAULT_IDLE_MS = 1500;
export const DEFAULT_IDLE_WAIT_MS = 15000;
export const POLL_MS = 250;

const IOREG_TIMEOUT_MS = 5000;
const IOREG_MAX_BUFFER = 8 * 1024 * 1024;
const NS_PER_MS = 1e6;

/**
 * HIDIdleTime is nanoseconds since the last keyboard or mouse event. Returns
 * milliseconds, or null when the output has no reading. Several entries can
 * appear, and the smallest is the most recent input, so that one wins.
 * Exported for unit tests.
 */
export function parseIdleMs(text) {
  const readings = [...String(text).matchAll(/"HIDIdleTime"\s*=\s*(\d+)/g)].map((match) => Number(match[1]));
  if (readings.length === 0) return null;
  return Math.min(...readings) / NS_PER_MS;
}

/** The HID idle time in ms. Needs no permission, and spawns ioreg directly rather than osascript. */
export async function readHidIdleMs() {
  const { stdout } = await execFileAsync('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], {
    timeout: IOREG_TIMEOUT_MS,
    maxBuffer: IOREG_MAX_BUFFER
  });
  const idle = parseIdleMs(stdout);
  if (idle === null) throw new Error('ioreg printed no HIDIdleTime');
  return idle;
}

function parseMs(name, raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: fallback };
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return { value: Math.round(value) };
  // A typo must not stop the server, and must not be silent: arc_status reports it.
  return { value: fallback, warning: `${name}="${raw}" is not a number of milliseconds. Using ${fallback}.` };
}

/** Reads ARC_MCP_IDLE_MS (0 disables the gate) and ARC_MCP_IDLE_WAIT_MS. */
export function parseActivityConfig(env = process.env) {
  const idle = parseMs('ARC_MCP_IDLE_MS', env.ARC_MCP_IDLE_MS, DEFAULT_IDLE_MS);
  const wait = parseMs('ARC_MCP_IDLE_WAIT_MS', env.ARC_MCP_IDLE_WAIT_MS, DEFAULT_IDLE_WAIT_MS);
  return {
    idleMs: idle.value,
    waitMs: wait.value,
    warnings: [idle.warning, wait.warning].filter(Boolean)
  };
}

export const USER_ACTIVE_ERROR =
  'The user is using the Mac right now (typing or moving the mouse), so nothing was opened and no window was touched. ' +
  'Retry in a little while. Reading and scripting tabs that are already open still works meanwhile.';

/** The failure a gated tool returns when the user never paused. */
export const userActiveResult = (gate) => ({
  ok: false,
  userActive: true,
  error: USER_ACTIVE_ERROR,
  waitedForUserMs: gate.waitedForUserMs,
  ...(gate.idleMs !== undefined ? { userIdleMs: Math.round(gate.idleMs) } : {})
});

/** Thrown from code that is already past a tool's own gate check. */
export class UserActiveError extends Error {
  constructor(gate) {
    super(USER_ACTIVE_ERROR);
    this.gate = gate;
  }
}

/**
 * Tools that can change what is on screen or which window has focus, and when.
 * A function decides per call, because open_url only does so for some
 * arguments. Everything not listed is background work and is never gated: the
 * test suite makes every tool state which side it is on.
 */
export const GATED_TOOLS = {
  // A new tab raises its window, a Little Arc is a window of its own, and
  // activate brings Arc forward. Navigating an existing tab in place does none
  // of that.
  open_url: (args) => args.new_tab !== false || args.little_arc === true || args.activate === true,
  switch_to_tab: () => true,
  focus_space: () => true,
  // Over CDP a screenshot reads a background tab without showing it; only
  // activate (Page.bringToFront) changes what the user sees.
  screenshot: (args) => args.activate === true
};

export const needsIdle = (toolName, args = {}) => {
  const policy = GATED_TOOLS[toolName];
  return Boolean(policy && policy(args));
};

/**
 * The gate as a tool wrapper sees it: { proceed: true, ... } to run the tool,
 * or { proceed: false, result } with the userActive failure to return instead.
 */
export async function gateTool(toolName, args, gate = activity) {
  if (!needsIdle(toolName, args)) return { proceed: true };
  const waited = await gate.wait();
  if (!waited.ok) return { proceed: false, result: userActiveResult(waited) };
  return {
    proceed: true,
    waitedForUserMs: waited.disabled ? null : waited.waitedForUserMs,
    unverified: waited.unverified
  };
}

/** Adds how long the user was waited for to a tool's own result. */
export function withGate(result, gate) {
  if (gate.waitedForUserMs === undefined || gate.waitedForUserMs === null) return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return {
    ...result,
    // open_url's own gates may have waited too.
    waitedForUserMs: gate.waitedForUserMs + (result.waitedForUserMs || 0),
    ...(gate.unverified ? { userIdleCheck: gate.unverified } : {})
  };
}

/**
 * `read`, `sleep` and `now` are injectable so tests need neither ioreg nor the
 * clock. wait() resolves to { ok: true, waitedForUserMs } once the user has been
 * idle for idleMs, or { ok: false, userActive: true, ... } when waitMs passes
 * first. It never rejects: an unreadable idle time fails open with a note,
 * since refusing every tool because ioreg broke would be worse than the risk.
 */
export function createActivityGate({
  read = readHidIdleMs,
  idleMs = DEFAULT_IDLE_MS,
  waitMs = DEFAULT_IDLE_WAIT_MS,
  pollMs = POLL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  warnings = []
} = {}) {
  async function wait() {
    if (idleMs <= 0) return { ok: true, disabled: true, waitedForUserMs: 0 };
    const started = now();
    let idle;
    try {
      idle = await read();
      while (idle < idleMs) {
        const waited = now() - started;
        if (waited >= waitMs) return { ok: false, userActive: true, waitedForUserMs: waited, idleMs: idle };
        await sleep(Math.min(pollMs, waitMs - waited));
        idle = await read();
      }
    } catch (error) {
      return { ok: true, waitedForUserMs: now() - started, unverified: `Could not read the user's idle time: ${error.message}` };
    }
    return { ok: true, waitedForUserMs: now() - started, idleMs: idle };
  }

  /** Current idle time for arc_status. Never throws. */
  async function status() {
    const base = { gate: idleMs > 0 ? 'on' : 'off', requiredIdleMs: idleMs, maxWaitMs: waitMs };
    const withWarnings = warnings.length > 0 ? { ...base, configWarnings: warnings } : base;
    try {
      return { ...withWarnings, userIdleMs: Math.round(await read()) };
    } catch (error) {
      return { ...withWarnings, userIdleMs: null, error: error.message };
    }
  }

  return { wait, status };
}

const activityConfig = parseActivityConfig();

export const activity = createActivityGate({
  idleMs: activityConfig.idleMs,
  waitMs: activityConfig.waitMs,
  warnings: activityConfig.warnings
});
