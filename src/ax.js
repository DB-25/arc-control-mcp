import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const AX_TIMEOUT_MS = 10000;
const WINDOW_PREFIX = 'bigBrowserWindow-';
const ID_PATTERN = /^[0-9A-F-]{36}$/i;

export const ACCESSIBILITY_NOTE =
  'Placing the agent window and putting your window back in front need Accessibility access. ' +
  'Grant it in System Settings > Privacy & Security > Accessibility to the app that runs this server ' +
  '(for example Terminal or Claude), then restart that app. Until then the agent window is still ' +
  'created and used, but it is not moved out of the way and your window is not restored if Arc raises another.';

export const AUTOMATION_NOTE =
  'Controlling windows needs Automation access to System Events. Enable System Events under this app in ' +
  'System Settings > Privacy & Security > Automation, then restart the app. Until then the agent window is ' +
  'not moved and your window is not restored if Arc raises another.';

export class AxPermissionError extends Error {}
export class AxError extends Error {}

/**
 * -25211 is "assistive access not allowed" and -1719 is what a refused
 * accessibility query reports. -1743 is the separate Automation grant for
 * System Events. Exported for unit tests.
 */
export function mapAxError(message) {
  if (/-25211|-1719|assistive access|not allowed assistive/i.test(message)) {
    return new AxPermissionError(ACCESSIBILITY_NOTE);
  }
  if (/-1743|not authori[sz]ed to send apple events/i.test(message)) {
    return new AxPermissionError(AUTOMATION_NOTE);
  }
  return new AxError(message);
}

async function runOsascript(args) {
  try {
    const { stdout } = await execFileAsync('osascript', args, { timeout: AX_TIMEOUT_MS });
    return stdout.trim();
  } catch (error) {
    // error.message embeds the whole argv, which for a script is its source.
    throw mapAxError((error.stderr || '').trim() || error.message);
  }
}

const defaultRun = (script) => runOsascript(['-e', script]);

function requireId(id) {
  // The id goes into AppleScript source, so only the shape of a window id may.
  if (!ID_PATTERN.test(String(id))) throw new AxError(`Not a window id: ${id}`);
  return id;
}

const windowOf = (id) =>
  `first window whose value of attribute "AXIdentifier" is "${WINDOW_PREFIX}${requireId(id)}"`;

const withArc = (body) => `tell application "System Events" to tell process "Arc"\n${body}\nend tell`;

// Arc's bundle id: the app's own name can be localised or renamed, this cannot.
export const ARC_BUNDLE_ID = 'company.thebrowser.Browser';
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Whether an app record from frontApp() is Arc. */
export const isArcApp = (app) => Boolean(app) && (app.bundleId === ARC_BUNDLE_ID || app.name === 'Arc');

/** Whether two app records name the same application. */
export const sameApp = (a, b) => Boolean(a && b) && (a.bundleId && b.bundleId ? a.bundleId === b.bundleId : a.name === b.name);

// Goes into AppleScript source inside quotes, so nothing may end the string.
function quoted(text) {
  if (/[\u0000-\u001f]/.test(text)) throw new AxError(`Not an application name: ${JSON.stringify(text)}`);
  return `"${text.replace(/[\\"]/g, '\\$&')}"`;
}

const toNumbers = (text) => text.split(',').map((part) => Number(part.trim()));

/**
 * Window placement and focus through Accessibility. Arc's own scripting cannot
 * move a window or change its z-order, and a new window takes keyboard focus
 * from the one the user is typing in, so this is the only way to fix either.
 * Arc names each window's AXIdentifier `bigBrowserWindow-<scripting id>`, which
 * is what ties an AX window to the id Arc's scripting reports. `run` is
 * injectable so tests need no Arc.
 */
export function createAxDriver(run = defaultRun) {
  return {
    /** Ids of every Arc window Accessibility can see, minimized ones included. */
    async windowIds() {
      const out = await run(withArc('get value of attribute "AXIdentifier" of every window'));
      return out
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(WINDOW_PREFIX))
        .map((part) => part.slice(WINDOW_PREFIX.length));
    },

    /**
     * The application the user is in, by name and bundle id. Works whether or
     * not Arc is running, which is what a cold start needs.
     */
    async frontApp() {
      const out = await run(
        `tell application "System Events"
set p to first application process whose frontmost is true
return (name of p) & "|" & (bundle identifier of p)
end tell`
      );
      const cut = out.lastIndexOf('|');
      if (cut < 0 || !out.slice(0, cut).trim()) throw new AxError(`Unreadable frontmost application: ${out}`);
      const bundleId = out.slice(cut + 1).trim();
      return { name: out.slice(0, cut).trim(), bundleId: BUNDLE_ID_PATTERN.test(bundleId) ? bundleId : null };
    },

    /** Bring an application forward again, as clicking it in the Dock would. */
    async activateApp(app) {
      const match = app.bundleId && BUNDLE_ID_PATTERN.test(app.bundleId) ? `bundle identifier is ${quoted(app.bundleId)}` : `name is ${quoted(app.name)}`;
      await run(`tell application "System Events" to set frontmost of (first application process whose ${match}) to true`);
    },

    /** Whether Arc is frontmost and the id of the window holding focus. Never a title. */
    async focus() {
      const out = await run(
        withArc(
          `set fw to ""
try
set fw to value of attribute "AXIdentifier" of (value of attribute "AXFocusedWindow")
end try
return (frontmost as text) & "|" & fw`
        )
      );
      const [frontmost, focused] = out.split('|');
      const focusedId = (focused || '').trim();
      return {
        frontmost: frontmost.trim() === 'true',
        focusedId: focusedId.startsWith(WINDOW_PREFIX) ? focusedId.slice(WINDOW_PREFIX.length) : null
      };
    },

    /**
     * Position, size and minimized flag of every Arc window, in one call. The
     * guard compares these before and after anything that creates or places a
     * window, because on 5 Oct 2026 the user's own window moved onto the
     * agent window's display during the first window creation.
     */
    async frames() {
      const out = await run(
        withArc(
          `set out to ""
repeat with w in windows
try
set p to position of w
set s to size of w
set out to out & (value of attribute "AXIdentifier" of w) & "|" & (item 1 of p) & "," & (item 2 of p) & "," & (item 1 of s) & "," & (item 2 of s) & "|" & (value of attribute "AXMinimized" of w) & linefeed
end try
end repeat
return out`
        )
      );
      return out
        .split('\n')
        .map((line) => line.trim().split('|'))
        .filter(([ident]) => ident && ident.startsWith(WINDOW_PREFIX))
        .map(([ident, rect, minimized]) => {
          const [x, y, width, height] = toNumbers(rect);
          return { id: ident.slice(WINDOW_PREFIX.length), x, y, width, height, minimized: minimized === 'true' };
        });
    },

    /** Position, size and minimized flag of one window. */
    async state(id) {
      const out = await run(
        withArc(
          `set w to (${windowOf(id)})
return {position of w, size of w, value of attribute "AXMinimized" of w}`
        )
      );
      const parts = out.split(',').map((part) => part.trim());
      const [x, y, width, height] = toNumbers(parts.slice(0, 4).join(','));
      return { x, y, width, height, minimized: parts[4] === 'true' };
    },

    /** Put a window back in front. Raising does not activate Arc if another app is frontmost. */
    async raise(id) {
      await run(
        withArc(
          `set w to (${windowOf(id)})
perform action "AXRaise" of w
set value of attribute "AXMain" of w to true`
        )
      );
    },

    async place(id, rect) {
      // Size first, then position twice: a resize near a screen edge can shift
      // the origin, and macOS clamps a position that would leave the window off-screen.
      await run(
        withArc(
          `set w to (${windowOf(id)})
set size of w to {${Math.round(rect.width)}, ${Math.round(rect.height)}}
set position of w to {${Math.round(rect.x)}, ${Math.round(rect.y)}}
set position of w to {${Math.round(rect.x)}, ${Math.round(rect.y)}}`
        )
      );
    },

    async setMinimized(id, minimized) {
      await run(withArc(`set value of attribute "AXMinimized" of (${windowOf(id)}) to ${minimized ? 'true' : 'false'}`));
    }
  };
}

const SCREENS_SCRIPT = `
ObjC.import('AppKit');
const screens = $.NSScreen.screens;
const rect = (r) => ({ x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height });
const out = [];
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i);
  out.push({ frame: rect(s.frame), visibleFrame: rect(s.visibleFrame) });
}
JSON.stringify(out);
`;

/** NSScreen frames, main display first. Needs no permission. */
export async function readScreens() {
  const out = await runOsascript(['-l', 'JavaScript', '-e', SCREENS_SCRIPT]);
  return JSON.parse(out);
}
