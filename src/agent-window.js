import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';

import { runJxa, ArcError, bindAgentWindowId } from './jxa.js';
import { createAxDriver, readScreens, AxPermissionError, AxError, ACCESSIBILITY_NOTE } from './ax.js';
import { createFocusGuard } from './focus-guard.js';
import { planPlacement, displayOfWindow } from './placement.js';
import { windowConfig } from './window-config.js';
import { activity, UserActiveError } from './user-activity.js';
import * as state from './state.js';

// How long a "no Accessibility" answer is trusted before asking again, so a
// user who grants it does not have to restart, and one who has not does not
// pay an osascript call on every tool call.
const AX_RECHECK_MS = 60000;
const WINDOW_APPEAR_TIMEOUT_S = 4;

// Exported so a test can parse-check them: node --check cannot see inside a
// template literal, and a syntax error here would only show up against Arc.
export const LIST_SCRIPT = `if (!Arc.running() && P.launch) {
  Arc.launch();
  // A launch restores windows asynchronously. Creating one before they
  // arrive would leave the user with an extra.
  for (let n = 0; n < 8 && Arc.windows.length === 0; n++) delay(0.5);
}
const rows = [];
if (Arc.running()) {
  for (let i = 0; i < Arc.windows.length; i++) {
    const w = Arc.windows[i];
    let visible = false;
    try { visible = w.visible(); } catch (e) { /* phantom */ }
    rows.push({ id: idOf(w), visible: visible });
  }
}
JSON.stringify(rows);`;

export const CREATE_SCRIPT = `Arc.make({ new: "window" });
let found = null;
for (let n = 0; n < ${WINDOW_APPEAR_TIMEOUT_S * 10} && !found; n++) {
  for (let i = 0; i < Arc.windows.length; i++) {
    const id = idOf(Arc.windows[i]);
    if (id && P.before.indexOf(id) < 0) found = id;
  }
  if (!found) delay(0.1);
}
JSON.stringify({ id: found });`;

/**
 * Arc side of the agent window, over JXA. Windows are matched by id, and a new
 * one is found by diffing ids before and after, because Arc's creation command
 * returns no reference. `Arc.Window().make()` crashes osascript (exit 139) even
 * though the window is created, while `Arc.make({ new: "window" })` does not.
 */
export const arcDriver = {
  /**
   * Every window in Arc's collection with whether it is visible. Launches Arc
   * if needed, unless `launch` is false, which is what a status read passes so
   * that looking never opens anything.
   */
  list: ({ launch = true } = {}) => runJxa(LIST_SCRIPT, { launch }),

  /** Create one window and return its id. */
  create: (before) => runJxa(CREATE_SCRIPT, { before }).then((out) => out.id)
};

function readStore(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw.windowId === 'string' && raw.windowId ? raw : null;
  } catch {
    return null;
  }
}

function writeStore(dir, file, record) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, file);
}

/**
 * The one window agent tabs live in. Shared by every label and session, so the
 * server must never create a second one: Arc ignores Close Window unless Arc is
 * frontmost and its windows have no Accessibility close button, so an extra
 * window can never be cleaned up from here. Everything that could create one
 * therefore runs under a cross-process lock and re-checks the persisted id
 * first.
 *
 * Everything that can change what is on screen first waits for the user to be
 * idle (`gate`), and runs inside `withWindow`, which puts the user's window
 * back in front if Arc raised another one.
 */
export function createAgentWindowManager({
  dir,
  arc = arcDriver,
  ax = createAxDriver(),
  screens = readScreens,
  config = windowConfig,
  gate = () => activity.wait(),
  now = Date.now,
  labelOf = () => 'default'
} = {}) {
  const file = join(dir, 'agent-window.json');
  const lockFile = join(dir, 'agent-window.lock');
  let queue = Promise.resolve();
  let axCache = { available: null, at: 0 };
  let noted = false;
  let axUnreadable = null;

  /**
   * Whether Accessibility works right now. A grant or a refusal is cached; any
   * other failure is not. With Arc not running System Events has no "Arc"
   * process to ask, which is a cold start and not a missing permission: it
   * answers "unavailable for now" and is asked again next time, so the window
   * still gets created and Arc launched.
   */
  async function accessibility() {
    if (axCache.available === true) return true;
    if (axCache.available === false && now() - axCache.at < AX_RECHECK_MS) return false;
    try {
      await ax.windowIds();
      axCache = { available: true, at: now() };
      axUnreadable = null;
    } catch (error) {
      if (!(error instanceof AxPermissionError)) {
        if (!(error instanceof AxError)) throw error;
        axUnreadable = error.message;
        return false;
      }
      axCache = { available: false, at: now(), message: error.message };
    }
    return axCache.available;
  }

  // A permission failure is remembered. Any other Accessibility failure (Arc
  // quit meanwhile, a window that just closed) only means this step is skipped.
  const permissionLost = (error) => {
    if (error instanceof AxPermissionError) {
      axCache = { available: false, at: now(), message: error.message };
      return;
    }
    if (!(error instanceof AxError)) throw error;
  };

  // Said once per server run. Repeating it on every open_url would bury results.
  function noteOnce() {
    if (axCache.available !== false || noted) return undefined;
    noted = true;
    return axCache.message || ACCESSIBILITY_NOTE;
  }

  /**
   * Is the persisted window still there? Minimized and closed are told apart by
   * Accessibility. `certain` is false when they cannot be: without
   * Accessibility a minimized window and a closed phantom both read
   * visible=false, so the window is assumed to exist.
   */
  async function locate({ launch = true } = {}) {
    const stored = readStore(file);
    if (!stored) return { stored: null, exists: false, certain: true };
    const rows = await arc.list({ launch });
    const row = rows.find((r) => r.id === stored.windowId);
    if (await accessibility()) {
      // Accessibility lists a minimized window and drops a closed one, which
      // Arc's own `visible` cannot do.
      try {
        const ids = await ax.windowIds();
        return { stored, exists: ids.includes(stored.windowId) || Boolean(row && row.visible), certain: true, arcRows: rows };
      } catch (error) {
        permissionLost(error);
      }
    }
    // Guessing "gone" would create a second window, whereas a phantom merely
    // fails honestly on use.
    return { stored, exists: Boolean(row), certain: !row || row.visible, arcRows: rows };
  }

  async function place(id, requested) {
    if (requested === 'none') return { applied: 'none', placed: true };
    if (!(await accessibility())) return { applied: null, placed: false };
    try {
      const plan = planPlacement({ screens: await screens(), placement: requested, windowSize: await ax.state(id) });
      if (plan.action === 'move') await ax.place(id, plan.rect);
      if (plan.action === 'minimize') await ax.setMinimized(id, true);
      return { applied: plan.placement, placed: true, ...(plan.note ? { note: plan.note } : {}) };
    } catch (error) {
      permissionLost(error);
      return { applied: null, placed: false };
    }
  }

  /** An existing window, with any placement that is still owed applied. */
  async function adopt(found, gated) {
    let { stored } = found;
    let placementNote;
    // Placement that could not be applied earlier, because Accessibility was
    // missing, is applied once it is available. A placed window is never
    // moved again: the user may have put it somewhere on purpose.
    if (!stored.placed && (config.placement === 'none' || (await accessibility()))) {
      await gated();
      const result = await place(stored.windowId, config.placement);
      if (result.placed) {
        stored = { ...stored, placed: true, placement: result.applied };
        writeStore(dir, file, stored);
      }
      placementNote = result.note;
    }
    return { id: stored.windowId, created: false, certain: found.certain, placement: stored.placement ?? null, placementNote };
  }

  /**
   * Make the one window and record it. No waiting for the user in here: this
   * runs under the lock, and a wait of seconds would hold every other session
   * up behind it.
   */
  async function create(found) {
    const before = (found.arcRows || (await arc.list())).map((r) => r.id);
    const id = await arc.create(before);
    if (!id) {
      throw new ArcError('Arc did not report a new window after being asked to create one. Open Arc, then try again.');
    }
    // Recorded before it is placed, so a failure past this point can never
    // leave a window nobody remembers, which the next call would then duplicate.
    const record = { windowId: id, createdAt: new Date(now()).toISOString(), createdBy: labelOf(), requested: config.placement, placed: false };
    writeStore(dir, file, record);
    return record;
  }

  /** Place a window this call just created, after the lock is gone and the user has paused. */
  async function placeCreated(record, gated) {
    try {
      await gated();
    } catch (error) {
      // The window exists and stays recorded as unplaced, so the next call
      // places it. Say so, rather than let the failure claim nothing happened.
      if (error instanceof UserActiveError) throw new UserActiveError(error.gate, { created: true, id: record.windowId });
      throw error;
    }
    const result = await place(record.windowId, config.placement);
    if (result.placed) writeStore(dir, file, { ...record, placed: true, placement: result.applied });
    return { id: record.windowId, created: true, certain: true, placement: result.applied, placementNote: result.note };
  }

  /** Find the agent window, creating it only when it is truly gone. */
  function ensure(gated) {
    const run = async () => {
      // Fast path without the lock: the common call finds the window already there.
      const quick = await locate();
      if (quick.exists) return adopt(quick, gated);
      // Idle first, lock second: the wait for the user can last seconds, and
      // the lock is only for deciding and creating.
      await gated();
      mkdirSync(dir, { recursive: true });
      // Looked at again under the lock: another session may have created the
      // window while this one waited.
      const outcome = await state.withLockAsync(lockFile, async () => {
        const found = await locate();
        return found.exists ? { found } : { created: await create(found) };
      });
      return outcome.found ? adopt(outcome.found, gated) : placeCreated(outcome.created, gated);
    };
    // One at a time per process, so two tool calls in a batch cannot both
    // decide the window is missing before either has recorded one.
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  /** The persisted id, read from disk so another session's window is found. Synchronous: it feeds every script. */
  const currentId = () => readStore(file)?.windowId ?? null;

  /** A minimized agent window is minimized again if making a tab brought it back. */
  async function keepMinimized(id) {
    if (readStore(file)?.placement !== 'minimized' || !(await accessibility())) return;
    try {
      if (!(await ax.state(id)).minimized) await ax.setMinimized(id, true);
    } catch (error) {
      permissionLost(error);
    }
  }

  const guard = createFocusGuard({ ax, gate, accessibility, permissionLost });

  /**
   * Run `run({ id })` with the agent window found or created. Arc raises a
   * window when a tab or window is created in it, and with Arc frontmost that
   * takes keyboard focus from the window the user is typing in; launching or
   * activating Arc takes the front from whatever application they were using.
   * Both are captured first and put back afterwards. Without Accessibility
   * there is no window to compare, but the application is still restored, and
   * placement is skipped with a one-time note.
   * Throws UserActiveError when the user never paused.
   */
  async function withWindow(run, { restoreFocus = true } = {}) {
    let waited = 0;
    const gated = async () => {
      const result = await gate();
      waited += result.waitedForUserMs || 0;
      if (!result.ok) throw new UserActiveError(result);
    };

    // Before the focus is captured, so what is captured is what the user chose
    // after they stopped typing.
    await gated();
    const snapshot = restoreFocus ? await guard.capture() : { app: null, window: null };

    let value;
    let window;
    let failure = null;
    try {
      window = await ensure(gated);
      try {
        await gated();
      } catch (error) {
        // The window may have been made by this very call.
        if (error instanceof UserActiveError && window.created) throw new UserActiveError(error.gate, { created: true, id: window.id });
        throw error;
      }
      value = await run(window);
      if (window.placement === 'minimized') await keepMinimized(window.id);
    } catch (error) {
      failure = error;
    }

    const restored = await guard.restore(snapshot, { agentWindowId: window?.id ?? null });
    if (failure) {
      // A closed window and a minimized one look alike without Accessibility.
      if (window && !window.certain && !(failure instanceof UserActiveError)) {
        failure.message += ` The agent window ${window.id} may have been closed. Accessibility is off, so it cannot be told from a minimized one. Grant Accessibility (see arc_status), or delete ${file} so a new window is made.`;
      }
      throw failure;
    }
    const note = noteOnce();
    return {
      value,
      window,
      ...guard.fields(restored, waited),
      ...(note ? { accessibilityNote: note } : {})
    };
  }

  /**
   * The same protection for work on a tab that already exists but can bring
   * Arc forward, such as a screenshot that activates its tab. No window is
   * found or created. The caller has already waited for the user to pause.
   */
  async function protectFocus(run) {
    const snapshot = await guard.capture();
    let value;
    let failure = null;
    try {
      value = await run();
    } catch (error) {
      failure = error;
    }
    const restored = await guard.restore(snapshot);
    if (failure) throw failure;
    return { value, ...guard.fields(restored, 0) };
  }

  /** Read-only: never creates a window, never launches Arc. */
  async function status() {
    const stored = readStore(file);
    const available = await accessibility();
    const base = {
      mode: config.mode,
      placementRequested: config.placement,
      accessibility: available
        ? { available: true }
        : axCache.available === false
          ? { available: false, note: axCache.message || ACCESSIBILITY_NOTE }
          // Not a refusal: Accessibility could not be asked, typically because Arc is not running.
          : { available: false, unknown: true, note: `Accessibility could not be checked right now (${axUnreadable}). This is expected while Arc is not running.` },
      stateFile: file,
      ...(config.warnings.length > 0 ? { configWarnings: config.warnings } : {})
    };
    if (!stored) return { ...base, windowId: null, exists: false };
    const { exists } = await locate({ launch: false });
    const out = { ...base, windowId: stored.windowId, exists, placement: stored.placement ?? null, createdBy: stored.createdBy };
    if (!exists || !available) return out;
    try {
      const geometry = await ax.state(stored.windowId);
      return {
        ...out,
        minimized: geometry.minimized,
        display: geometry.minimized ? null : displayOfWindow(await screens(), geometry)
      };
    } catch (error) {
      permissionLost(error);
      return out;
    }
  }

  return { withWindow, protectFocus, status, currentId, accessibility };
}

export const agentWindow = createAgentWindowManager({ dir: state.stateDir(), labelOf: state.label });

// Only in dedicated mode does a persisted window change how scripts see Arc's
// windows: in space mode an old file must not hide a window from the user's list.
if (windowConfig.mode === 'dedicated') bindAgentWindowId(agentWindow.currentId);
