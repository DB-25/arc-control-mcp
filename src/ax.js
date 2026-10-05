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
