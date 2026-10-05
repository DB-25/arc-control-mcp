import { AxPermissionError, isArcApp, sameApp } from './ax.js';

/**
 * Remembers what the user is looking at and puts it back. Arc raises a window
 * when a tab or window is created in it, and with Arc frontmost that takes
 * keyboard focus from the window the user is typing in; launching or
 * activating Arc takes the front from whatever application they were using.
 *
 * The manager injects what it owns: `accessibility()` (whether windows can be
 * read), `permissionLost(error)` (remember a refusal, ignore a transient
 * failure, rethrow anything else) and the user-activity `gate`.
 */
export function createFocusGuard({ ax, gate, accessibility, permissionLost }) {
  /**
   * The application in front, and which Arc window holds focus. Both are
   * read-only questions. The application is asked even when Arc is not running,
   * since a cold start is exactly when launching Arc takes the front; the
   * window only with Accessibility.
   */
  async function capture() {
    const snapshot = { app: null, window: null };
    try {
      snapshot.app = await ax.frontApp();
    } catch (error) {
      permissionLost(error);
    }
    if (await accessibility()) {
      try {
        snapshot.window = await ax.focus();
      } catch (error) {
        permissionLost(error);
      }
    }
    return snapshot;
  }

  /**
   * Put the user's window, then their application, back in front if either was
   * displaced. Never throws. `restored` is true only when something was
   * displaced and all of it was put back, with the front application read
   * again to confirm; anything else that goes wrong is in `error`.
   */
  async function restore(snapshot) {
    const out = { restored: false, waited: 0 };
    const errors = [];
    // Restored means everything that was displaced is back, not just some of it.
    let displaced = 0;
    let fixed = 0;
    // Each raise waits for a pause in typing, since it too lands on the screen.
    const quiet = async () => {
      const result = await gate();
      out.waited += result.waitedForUserMs || 0;
      return result;
    };

    if (snapshot.window?.focusedId) {
      try {
        const after = await ax.focus();
        if (after.focusedId !== snapshot.window.focusedId) {
          displaced++;
          if (!(await quiet()).ok) errors.push('The user was busy, so their window was not put back in front.');
          else {
            await ax.raise(snapshot.window.focusedId);
            fixed++;
          }
        }
      } catch (error) {
        if (error instanceof AxPermissionError) permissionLost(error);
        else errors.push(error.message);
      }
    }

    // Arc coming to the front over another application is how a launch or a
    // new window behaves. The window raise above does not undo it.
    if (snapshot.app && !isArcApp(snapshot.app)) {
      try {
        if (isArcApp(await ax.frontApp())) {
          displaced++;
          if (!(await quiet()).ok) errors.push('The user was busy, so the application they were in was not put back in front.');
          else {
            await ax.activateApp(snapshot.app);
            if (sameApp(await ax.frontApp(), snapshot.app)) fixed++;
            else errors.push(`Asked for ${snapshot.app.name} to be put back in front, but it is not frontmost.`);
          }
        }
      } catch (error) {
        if (error instanceof AxPermissionError) permissionLost(error);
        else errors.push(error.message);
      }
    }

    out.restored = displaced > 0 && fixed === displaced;
    if (errors.length > 0) out.error = errors.join(' ');
    return out;
  }

  /** The restore outcome as the fields a tool result carries. */
  const fields = (restored, waitedForUserMs) => ({
    waitedForUserMs: waitedForUserMs + restored.waited,
    focusRestored: restored.restored,
    ...(restored.error ? { focusRestoreError: restored.error } : {})
  });

  return { capture, restore, fields };
}
