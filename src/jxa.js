import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// Shared helpers injected ahead of every script body. Arc's scripting bridge
// refuses a bulk `w.tabs()` fetch but happily returns bulk property arrays
// (`w.tabs.id()`), which is ~10x fewer Apple Events than looping per tab.
// Exported so tests can parse-check it: node --check cannot see inside a
// template literal, so a syntax error here would only appear at runtime.
export const PREAMBLE = `
const Arc = Application("Arc");

// Arc keeps closed windows in its scripting collection as invisible phantoms
// whose activeTab is unreachable, so every lookup must filter on visible().
function liveWindows() {
  const live = [];
  for (let i = 0; i < Arc.windows.length; i++) {
    const w = Arc.windows[i];
    try {
      if (w.visible()) live.push(w);
    } catch (e) { /* phantom */ }
  }
  return live;
}

function mainWindow() {
  const live = liveWindows();
  if (live.length === 0) throw new Error("ARC_NO_WINDOW");
  return live[0];
}

function requireArc() {
  if (!Arc.running()) throw new Error("ARC_NOT_RUNNING");
  if (liveWindows().length === 0) throw new Error("ARC_NO_WINDOW");
}

function snapshot() {
  const rows = [];
  const live = liveWindows();
  for (let wi = 0; wi < live.length; wi++) {
    const w = live[wi];
    const ids = w.tabs.id();
    const titles = w.tabs.title();
    const urls = w.tabs.url();
    const locations = w.tabs.location();
    const windowId = w.id();
    const activeId = w.activeTab.id();

    // Which space each tab belongs to, so callers can tell agent tabs from the
    // user's without opening anything.
    const spaceOf = {};
    try {
      for (let si = 0; si < w.spaces.length; si++) {
        const sp = w.spaces[si];
        const spIds = sp.tabs.id();
        const spTitle = sp.title();
        for (let k = 0; k < spIds.length; k++) spaceOf[spIds[k]] = spTitle;
      }
    } catch (e) { /* spaces unavailable */ }

    for (let ti = 0; ti < ids.length; ti++) {
      rows.push({
        id: ids[ti],
        title: titles[ti],
        url: urls[ti],
        location: locations[ti],
        space: spaceOf[ids[ti]] || null,
        windowId: windowId,
        windowIndex: wi + 1,
        tabIndex: ti + 1,
        isActive: ids[ti] === activeId
      });
    }
  }
  return rows;
}

function locate(tabId) {
  const live = liveWindows();
  for (let wi = 0; wi < live.length; wi++) {
    const w = live[wi];
    const ids = w.tabs.id();
    for (let ti = 0; ti < ids.length; ti++) {
      if (ids[ti] === tabId) return w.tabs[ti];
    }
  }
  return null;
}

// Prefers a tab this agent opened, then falls back to whatever is active, so
// the user can point it at their own tabs without looking up an id.
function target() {
  requireArc();
  if (P.tab_id) {
    const tab = locate(P.tab_id);
    if (!tab) throw new Error("TAB_NOT_FOUND:" + P.tab_id);
    return tab;
  }
  if (P.default_tab_id) {
    const tab = locate(P.default_tab_id);
    if (tab) return tab;
  }
  return mainWindow().activeTab;
}

function agentSpace() {
  return P.agent_space ? findSpace(P.agent_space) : null;
}

// Arc returns the JSON encoding of whatever the page expression evaluated to,
// so a string arrives wrapped in quotes and an object as JSON text.
function evalJs(tab, code) {
  const raw = Arc.execute(tab, { javascript: code });
  // Arc returns empty when the injected script fails to parse. That is
  // indistinguishable from a page value of null unless we say so explicitly.
  if (raw === undefined || raw === null || raw === "") {
    return {
      __arc: 1,
      ok: false,
      name: "ScriptError",
      error: "Arc returned no result for the injected script. It most likely failed to parse, or Arc is blocking JavaScript from Apple Events (Arc > Settings > Advanced)."
    };
  }
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

function describe(tab) {
  const id = tab.id();
  const owned = P.owned_ids || [];
  // The mine flag makes it obvious in every response whether this touched an
  // agent tab or one of the user's own.
  return { id: id, title: tab.title(), url: tab.url(), location: tab.location(), mine: owned.indexOf(id) >= 0 };
}

function findSpace(needle) {
  const w = mainWindow();
  const count = w.spaces.length;
  for (let i = 0; i < count; i++) {
    const space = w.spaces[i];
    if (space.id() === needle || space.title() === needle) return space;
  }
  return null;
}
`;

// JSON is a JS-literal subset apart from the line separators, which older
// JavaScriptCore parsers reject inside string literals.
// Exported for unit tests; not part of the tool surface.
export function jsLiteral(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export class ArcError extends Error {}

// osascript appends its own " (-2700)" style code to the thrown message
function sentinel(message, name) {
  const match = message.match(new RegExp(name + ':(.+?)(?:\\s*\\(-\\d+\\))?\\s*$', 'm'));
  return match ? match[1].trim() : null;
}

// Exported for unit tests; not part of the tool surface.
export function friendly(message) {
  const tabNotFound = sentinel(message, 'TAB_NOT_FOUND');
  if (tabNotFound) {
    return `No open Arc tab has id ${tabNotFound}. Run list_tabs to get current tab ids (they change when a tab is closed and reopened).`;
  }
  const spaceNotFound = sentinel(message, 'SPACE_NOT_FOUND');
  if (spaceNotFound) {
    return `No Arc space matches "${spaceNotFound}". Run list_spaces to see the available ids and titles.`;
  }
  const noMatch = sentinel(message, 'SELECTOR_NO_MATCH');
  if (noMatch) {
    return `No element on the page matches the selector "${noMatch}".`;
  }
  if (message.includes('ARC_NOT_RUNNING')) {
    return 'Arc is not running. Launch Arc, or use open_url, which starts it.';
  }
  if (message.includes('ARC_NO_WINDOW')) {
    return 'Arc is running but has no open windows. Open a window (Cmd-N) and try again.';
  }
  if (message.includes('-1743') || /not authoriz|assistive access/i.test(message)) {
    return [
      'Permission denied: controlling Arc needs automation access.',
      'System Settings > Privacy & Security > Automation > enable "Arc" under this app,',
      'then restart the app.'
    ].join('\n');
  }
  if (/javascript/i.test(message) && /(turned off|disabled|not allowed)/i.test(message)) {
    return 'Arc is blocking JavaScript from Apple Events. Enable it in Arc > Settings > Advanced ("Allow JavaScript from Apple Events").';
  }
  if (message.includes('-600') || /isn't running|is not running/i.test(message)) {
    return 'Arc is not running. Launch Arc, or use open_url, which starts it.';
  }
  return message;
}

/**
 * Run a JXA body against Arc. `params` is exposed to the script as `P`, so
 * arguments are never string-concatenated into the source.
 * The body's final expression must be a JSON string.
 */
export async function runJxa(body, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const script = `const P = ${jsLiteral(params)};\n${PREAMBLE}\n${body}`;
  let stdout;
  try {
    ({ stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES
    }));
  } catch (error) {
    if (error.killed || error.signal) {
      throw new ArcError(`Arc did not respond within ${timeoutMs / 1000}s. It may be showing a dialog or busy loading.`);
    }
    // error.message embeds the whole `-e <script>` argv, which would false-match our sentinels
    const detail = (error.stderr || '').trim() || error.message;
    throw new ArcError(friendly(detail));
  }

  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ArcError(`Unexpected output from Arc: ${text.slice(0, 400)}`);
  }
}
