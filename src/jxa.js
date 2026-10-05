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
// A minimized window is invisible too, which is why the agent window, which may
// be minimized on purpose, is handled apart from the user's windows.
function idOf(w) {
  try { return w.id(); } catch (e) { return null; }
}

// The user's windows. The agent window is excluded so that "the front window"
// and "the user's active tab" can never resolve to it.
function liveWindows() {
  const live = [];
  for (let i = 0; i < Arc.windows.length; i++) {
    const w = Arc.windows[i];
    try {
      if (w.visible() && idOf(w) !== P.agent_window_id) live.push(w);
    } catch (e) { /* phantom */ }
  }
  return live;
}

// The dedicated agent window, whether or not it is currently visible.
function agentWindow() {
  if (!P.agent_window_id) return null;
  for (let i = 0; i < Arc.windows.length; i++) {
    const w = Arc.windows[i];
    if (idOf(w) === P.agent_window_id) return w;
  }
  return null;
}

// Every window that can hold a tab this agent cares about: the user's first, so
// a tab keeps reporting the window it was found in, then the agent window.
function tabWindows() {
  const all = liveWindows();
  const agent = agentWindow();
  if (agent) all.push(agent);
  return all;
}

function mainWindow() {
  const live = liveWindows();
  if (live.length === 0) throw new Error("ARC_NO_WINDOW");
  return live[0];
}

function requireArc() {
  if (!Arc.running()) throw new Error("ARC_NOT_RUNNING");
  if (tabWindows().length === 0) throw new Error("ARC_NO_WINDOW");
}

function snapshot() {
  const rows = [];
  // Spaces, and so tabs, are shared by every window: each window's collection
  // lists all of them. Report each tab once, under the first window that has it.
  const seen = {};
  const live = tabWindows();
  const owned = P.owned_ids || [];
  for (let wi = 0; wi < live.length; wi++) {
    const w = live[wi];
    const isAgentWindow = !!P.agent_window_id && idOf(w) === P.agent_window_id;
    let ids;
    try { ids = w.tabs.id(); } catch (e) { continue; /* a closed agent window left behind */ }
    const titles = w.tabs.title();
    const urls = w.tabs.url();
    const locations = w.tabs.location();
    const windowId = w.id();
    // A freshly created window has no active tab at all.
    let activeId = null;
    try { activeId = w.activeTab.id(); } catch (e) { /* none */ }

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
      if (seen[ids[ti]]) continue;
      // A tab this agent opened belongs to the agent window, even though the
      // user's windows list it too.
      if (!isAgentWindow && P.agent_window_id && owned.indexOf(ids[ti]) >= 0) continue;
      seen[ids[ti]] = true;
      rows.push({
        id: ids[ti],
        title: titles[ti],
        url: urls[ti],
        location: locations[ti],
        space: spaceOf[ids[ti]] || null,
        windowId: windowId,
        windowIndex: wi + 1,
        tabIndex: ti + 1,
        // The agent window's selection is not what the user is looking at.
        isActive: !isAgentWindow && ids[ti] === activeId,
        inAgentWindow: isAgentWindow
      });
    }
  }
  return rows;
}

function locate(tabId) {
  // Tabs are listed by every window, and selecting one through the wrong window
  // would change that window's tab. A tab this agent opened is therefore looked
  // up through the agent window first, never through the user's.
  const agent = agentWindow();
  const live = agent && (P.owned_ids || []).indexOf(tabId) >= 0 ? [agent].concat(liveWindows()) : tabWindows();
  for (let wi = 0; wi < live.length; wi++) {
    const w = live[wi];
    let ids;
    try { ids = w.tabs.id(); } catch (e) { continue; /* a closed agent window left behind */ }
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
  // Falling through to the user's active tab is only safe for a tool that
  // reads. Doing it for one that acts is how an agent ends up reloading or
  // navigating the tab someone is working in, so refuse and say what to pass.
  if (P.allow_active_tab) return mainWindow().activeTab;
  throw new Error("NO_TARGET_TAB");
}

function agentSpace() {
  return P.agent_space ? findSpace(P.agent_space) : null;
}

// A space as one particular window lists it, which is what a tab pushed into it
// is created through.
function spaceIn(w, needle) {
  const count = w.spaces.length;
  for (let i = 0; i < count; i++) {
    const space = w.spaces[i];
    if (space.id() === needle || space.title() === needle) return space;
  }
  return null;
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
  return spaceIn(mainWindow(), needle);
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

// Set by agent-window.js when the dedicated window mode is on. A hook rather
// than an import, because that module itself runs scripts through this one.
let agentWindowId = () => null;
export function bindAgentWindowId(fn) {
  agentWindowId = fn;
}

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
  if (message.includes('NO_TARGET_TAB')) {
    return [
      'This tool changes a tab, and no tab was given. This agent has not opened one yet, and',
      'it will not act on whatever tab the user happens to be looking at.',
      'Pass an explicit tab_id from list_tabs, or call open_url first to get your own tab.'
    ].join('\n');
  }
  if (message.includes('AGENT_WINDOW_MISSING')) {
    return 'The agent window disappeared before a tab could be opened in it. Try again, and a new one is made if it is really gone.';
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
  // Every script, not only the ones built by scoped(), must know which window
  // is the agent's: locate() reads it, and close_own_tabs would otherwise skip
  // a tab that lives there.
  const withWindow = 'agent_window_id' in params ? params : { ...params, agent_window_id: agentWindowId() };
  const script = `const P = ${jsLiteral(withWindow)};\n${PREAMBLE}\n${body}`;
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
