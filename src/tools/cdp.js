/**
 * Tools that need the Chrome DevTools Protocol: trusted input, screenshots,
 * and console and network capture. Everything else in this server works
 * through Apple Events alone, so none of these are required for it.
 *
 * Arc serves the DevTools port only when launched with a flag. When nothing
 * answers, every tool here fails with the setup steps and nothing else changes.
 */
import { z, TAB_ID, SELECTOR, EXACT, NTH, timeoutMs } from './schema.js';
import { read, write } from './shared.js';
import { hasWebSocket } from '../cdp/client.js';
import { SECURITY_WARNING, setupInstructions } from '../cdp/engine.js';
import { runCdp, deps } from '../cdp/run.js';
import { screenshot, uploadFile, handleDialog } from '../cdp/page-ops.js';
import { trustedClick, trustedHover, trustedType, trustedPressKey, drag } from '../cdp/input-ops.js';
import { fail } from '../cdp/tab.js';

const SCREENSHOT_TIMEOUT_MS = 15000;
const MAX_LISTED = 500;
const DEFAULT_LISTED = 100;
const MAX_UPLOAD_FILES = 20;
const MAX_DRAG_STEPS = 100;
const MAX_CLICKS = 3;

// Which arguments of a tool name an element, for runCdp to resolve when one is a ref= or role= selector.
const SELECTOR_ARG = { selector: 'selector', nth: 'nth' };
const DRAG_SELECTORS = [
  { selector: 'from_selector', nth: 'from_nth' },
  { selector: 'to_selector', nth: 'to_nth' }
];

// These read, but they attach a debugger to the tab, so with no tab_id they
// resolve like a changing tool (an own tab, or a refusal) and never to the tab
// the user is looking at.
const OWN_TAB_ID = TAB_ID.describe(
  'Arc tab id from list_tabs. Omit to use the tab you opened last. Unlike other read tools this never falls back to the tab the user is looking at: with no id and no tab of yours it is refused, so pass this or call open_url first.'
);

const MATCH_EXACT = EXACT.describe('For "text=", "label=" and "placeholder=" selectors, require the whole trimmed text to equal the label. No effect on CSS, ref= or role= selectors.');
const LIMIT = z.number().min(1).max(MAX_LISTED).default(DEFAULT_LISTED).describe(`Newest entries to return, at most ${MAX_LISTED}`);

const CAPTURE_NOTE =
  'Capture starts the first time any CDP tool touches this tab, and CDP has no history to read back, so ' +
  'nothing from before that is here. Call this tool (or cdp_status then any CDP tool) before the action you want to observe.';

export const tools = [
  {
    name: 'cdp_status',
    description:
      'Report whether the Chrome DevTools Protocol engine can be used: the port, the browser answering on it, how many page targets it exposes, and the security warning. ' +
      'The engine is on by default and probes 127.0.0.1:9222 (ARC_MCP_CDP_PORT changes the port, ARC_MCP_CDP=0 disables it). Arc only serves the port when launched with --remote-debugging-port. ' +
      'Fails with ok false and the setup steps when nothing answers; every non-CDP tool is unaffected. Probes fresh each time, so it notices Arc being relaunched within one call.',
    input: z.strictObject({}),
    annotations: read('CDP Status', { openWorld: false })
  },
  {
    name: 'screenshot',
    description:
      'Take a screenshot of a tab and return it as an image: the viewport, the whole page (full_page), or one element (selector). Needs the DevTools engine (see cdp_status). ' +
      'Works on a background tab without bringing it forward; pass activate true only if you want Arc to show it (that waits for the user to pause, like open_url, and restores their focus afterwards). A full page is capped at 16384 px tall and the result says when it was cut. ' +
      'Prefer jpeg with a quality for a long page, since a large PNG is a lot of tokens.',
    input: z.object({
      tab_id: OWN_TAB_ID.optional(),
      selector: SELECTOR.describe('Capture just this element instead of the viewport. CSS selector, "text=Label", or ref=, role=, label=, placeholder= as in click.').optional(),
      nth: NTH.describe('Which match to capture when several exist, 0-based'),
      exact: MATCH_EXACT,
      full_page: z.boolean().default(false).describe('Capture the whole scrollable page, not just the viewport. Not combinable with selector.'),
      format: z.enum(['png', 'jpeg']).default('png').describe('Image format'),
      quality: z.number().min(1).max(100).default(80).describe('JPEG quality, 1-100. Ignored for png.'),
      activate: z.boolean().default(false).describe('Bring the tab to the front first. This changes what the user sees, so leave it off unless needed. It waits until the user has stopped typing, fails with userActive true if they never pause, and puts their window and application back in front afterwards (focusRestored says whether that worked).'),
      timeout_ms: timeoutMs(SCREENSHOT_TIMEOUT_MS, 'Give up on the capture after this long.')
    }),
    ownTabOnly: true,
    annotations: read('Screenshot')
  },
  {
    name: 'trusted_click',
    description:
      'Click an element with a real mouse event (isTrusted true), at its center after scrolling it into view. Use it when the synthetic click tool is ignored: widgets gated on event.isTrusted, ' +
      'autocomplete and menus that open on a real pointer, double clicks, right clicks. Needs the DevTools engine. Refuses a disabled control. ' +
      'Returns coveredBy when another element sits on top, because a real click lands on that element. Top-level page only: elements inside an iframe are not reachable by selector.',
    input: z.object({
      selector: SELECTOR,
      tab_id: TAB_ID.optional(),
      nth: NTH,
      exact: MATCH_EXACT,
      button: z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'),
      click_count: z.number().min(1).max(MAX_CLICKS).default(1).describe('1 for a click, 2 for a double click (the page gets dblclick), 3 for a triple click (selects a paragraph)')
    }),
    annotations: write('Trusted Click')
  },
  {
    name: 'trusted_type',
    description:
      'Type into an input, textarea or contenteditable with real input events, so autocomplete dropdowns open and frameworks see genuine typing. Needs the DevTools engine. ' +
      'By default the text goes in as one insertText (fast, one trusted input event). per_key sends a real keydown, keypress, input and keyup for every character, which is what search-as-you-type boxes need. ' +
      'With no selector it types into the element that already has focus. Refuses a disabled, readonly or non-text element, and a field that does not take focus (nothing is typed then, rather than typing into another element). The result reports the field value afterwards (a password reports only its length).',
    input: z.object({
      text: z.string().describe('Text to type'),
      selector: SELECTOR.describe('Field to focus first. CSS selector, "text=Label", or ref=, role=, label=, placeholder= as in click. Omit to type into the focused element.').optional(),
      tab_id: TAB_ID.optional(),
      nth: NTH,
      exact: MATCH_EXACT,
      per_key: z.boolean().default(false).describe('Send keydown, keypress, input and keyup for each character instead of one insertText'),
      clear: z.boolean().default(false).describe('Select the existing contents first so the typed text replaces them')
    }),
    annotations: write('Trusted Type')
  },
  {
    name: 'trusted_press_key',
    description:
      'Press a key or shortcut with real key events: Enter really submits a form, Tab really moves focus, Escape closes what it closes. Accepts names (Enter, Tab, Escape, ArrowDown, F5), single characters, and modifier combinations such as Meta+A, Meta+C, Shift+Tab, Control+Shift+K. ' +
      'Needs the DevTools engine. Meta is Command; on macOS the editing shortcuts (Meta+A, C, V, X, Z) work because the matching editing command is sent with them. ' +
      'Optionally focuses a selector first. Reports the element that has focus afterwards.',
    input: z.object({
      key: z.string().describe('Key or combination, for example Enter, Tab, ArrowDown, Meta+A, Shift+Tab'),
      selector: SELECTOR.describe('Focus this element first. CSS selector, "text=Label", or ref=, role=, label=, placeholder= as in click. Omit to press into whatever has focus.').optional(),
      tab_id: TAB_ID.optional(),
      nth: NTH,
      exact: MATCH_EXACT
    }),
    annotations: write('Trusted Press Key')
  },
  {
    name: 'trusted_hover',
    description:
      'Move a real mouse pointer over an element, so hover menus, tooltips and :hover styles appear. Needs the DevTools engine. Reports hoverApplied, whether the browser now considers the element hovered.',
    input: z.object({ selector: SELECTOR, tab_id: TAB_ID.optional(), nth: NTH, exact: MATCH_EXACT }),
    annotations: write('Trusted Hover', { idempotent: true })
  },
  {
    name: 'drag',
    description:
      'Drag with a real mouse: press at the start, move in steps, release at the end. Each end is a selector (its center) or x and y in viewport pixels. Works for sliders, sortable lists, canvases, and native HTML5 drag and drop (reported as nativeDrag true). ' +
      'Needs the DevTools engine. Top-level page only.',
    input: z.object({
      tab_id: TAB_ID.optional(),
      from_selector: SELECTOR.describe('Element to press on. CSS selector, "text=Label", or ref=, role=, label=, placeholder= as in click.').optional(),
      from_nth: NTH.describe('Which from_selector match to use, 0-based'),
      from_x: z.number().describe('Start x in viewport pixels, instead of from_selector').optional(),
      from_y: z.number().describe('Start y in viewport pixels, instead of from_selector').optional(),
      to_selector: SELECTOR.describe('Element to release on. CSS selector, "text=Label", or ref=, role=, label=, placeholder= as in click.').optional(),
      to_nth: NTH.describe('Which to_selector match to use, 0-based'),
      to_x: z.number().describe('End x in viewport pixels, instead of to_selector').optional(),
      to_y: z.number().describe('End y in viewport pixels, instead of to_selector').optional(),
      steps: z.number().min(1).max(MAX_DRAG_STEPS).default(12).describe('Intermediate mouse moves between start and end')
    }),
    annotations: write('Drag')
  },
  {
    name: 'upload_file',
    description:
      'Set the files of an <input type=file>, as if chosen in the file picker. Paths must be absolute and point at existing regular files; anything else is refused, as are credential, shell-history, mail and browser-profile files (~/.ssh, ~/.aws, Arc and Chrome profiles, Messages, Mail, Safari, Keychains, .env and .env.*, .zsh_history, and similar), whatever the letter case of the path. ' +
      'The page receives its normal input and change events. Needs the DevTools engine. Many sites hide the real input behind a button: select the hidden input element itself.',
    input: z.object({
      selector: SELECTOR.describe('The file input: a CSS selector such as input[type=file], "text=Label", or ref=, role=, label=, placeholder= as in click.'),
      paths: z.array(z.string()).min(1).max(MAX_UPLOAD_FILES).describe('Absolute paths of the files to attach'),
      tab_id: TAB_ID.optional(),
      nth: NTH,
      exact: MATCH_EXACT
    }),
    annotations: write('Upload File')
  },
  {
    name: 'handle_dialog',
    description:
      'Accept or dismiss the JavaScript dialog (alert, confirm, prompt, beforeunload) that is blocking a tab. While one is open the page cannot run anything, so other CDP tools say so and point here. ' +
      'For a prompt, prompt_text is what gets entered when accepting. Needs the DevTools engine.',
    input: z.object({
      action: z.enum(['accept', 'dismiss']).describe('accept presses OK, dismiss presses Cancel'),
      prompt_text: z.string().describe('Text to enter into a prompt() dialog when accepting').optional(),
      tab_id: TAB_ID.optional()
    }),
    annotations: write('Handle Dialog')
  },
  {
    name: 'console_messages',
    description:
      'Read the console output of a tab: console.log and friends, uncaught exceptions, and the browser\'s own messages (blocked requests, CSP violations). Newest last. Needs the DevTools engine. ' +
      CAPTURE_NOTE,
    input: z.object({
      tab_id: OWN_TAB_ID.optional(),
      level: z.enum(['all', 'error', 'warning', 'info', 'log', 'debug']).default('all').describe('Only entries of this level'),
      limit: LIMIT,
      clear: z.boolean().default(false).describe('Empty this tab\'s console buffer after reading, so the next call shows only what is new')
    }),
    ownTabOnly: true,
    annotations: read('Console Messages')
  },
  {
    name: 'network_requests',
    description:
      'List the network requests a tab has made: method, url, status, type, timing and transferred size. No bodies. Headers are left out unless include_headers is set, and even then cookie, authorization and set-cookie values are redacted. Needs the DevTools engine. ' +
      'Note that URLs are reported as they are, query string included. ' +
      CAPTURE_NOTE,
    input: z.object({
      tab_id: OWN_TAB_ID.optional(),
      url_contains: z.string().describe('Only requests whose url contains this text').optional(),
      type: z.string().describe('Only this resource type, for example Fetch, XHR, Document, Script, Image').optional(),
      failed_only: z.boolean().default(false).describe('Only requests that failed or returned status 400 or above'),
      limit: LIMIT,
      include_headers: z.boolean().default(false).describe('Include request and response headers, with credential headers redacted'),
      clear: z.boolean().default(false).describe('Empty this tab\'s network buffer after reading')
    }),
    ownTabOnly: true,
    annotations: read('Network Requests')
  }
];

/**
 * Page.bringToFront can bring Arc forward over the application the user is in
 * and raise another Arc window. Like every other visible operation, the
 * screenshot puts both back (the tab stays selected in its own window), and
 * says whether it managed to. The tool wrapper has already waited for the user
 * to pause.
 */
async function withFocusRestored(take) {
  const done = await deps.focus.protectFocus(take);
  return {
    ...done.value,
    focusRestored: done.focusRestored,
    ...(done.waitedForUserMs ? { waitedForUserMs: (done.value.waitedForUserMs || 0) + done.waitedForUserMs } : {}),
    ...(done.focusRestoreError ? { focusRestoreError: done.focusRestoreError } : {})
  };
}

export const handlers = {
  cdp_status: async () => {
    const status = await deps.engine.status();
    const { config } = status;
    const base = {
      enabled: config.enabled,
      host: '127.0.0.1',
      port: config.port,
      portSource: config.source,
      nodeWebSocket: hasWebSocket(),
      warning: SECURITY_WARNING
    };
    if (!status.reachable) {
      return { ok: false, ...base, reachable: false, error: status.reason, ...(config.enabled ? { setup: setupInstructions(config.port) } : {}) };
    }
    return {
      ok: true,
      ...base,
      reachable: true,
      browser: status.browser,
      protocolVersion: status.protocolVersion,
      targetCount: status.targetCount,
      attachedTabs: status.attachedTabs,
      note: 'Page targets are only driven after the marker this server writes into an Arc tab is found in them, so a different browser on this port is never controlled.'
    };
  },

  screenshot: (args, extra) => {
    if (args.selector && args.full_page) {
      return fail('Choose either selector or full_page, not both.');
    }
    const take = () => runCdp(args, extra, { selectors: [SELECTOR_ARG] }, (t, tab, a) => screenshot(t, a));
    return args.activate === true ? withFocusRestored(take) : take();
  },

  trusted_click: (args, extra) => runCdp(args, extra, { selectors: [SELECTOR_ARG] }, (t, tab, a) => trustedClick(t, a)),
  trusted_type: (args, extra) => runCdp(args, extra, { selectors: [SELECTOR_ARG] }, (t, tab, a) => trustedType(t, a)),
  trusted_press_key: (args, extra) => runCdp(args, extra, { selectors: [SELECTOR_ARG] }, (t, tab, a) => trustedPressKey(t, a)),
  trusted_hover: (args, extra) => runCdp(args, extra, { selectors: [SELECTOR_ARG] }, (t, tab, a) => trustedHover(t, a)),
  drag: (args, extra) => runCdp(args, extra, { selectors: DRAG_SELECTORS }, (t, tab, a) => drag(t, a)),
  upload_file: (args, extra) => runCdp(args, extra, { selectors: [SELECTOR_ARG] }, (t, tab, a) => uploadFile(t, a)),

  // Not gated on a pending dialog: it is the way out of one.
  handle_dialog: (args, extra) => runCdp(args, extra, { interacts: false }, (t) => handleDialog(t, args)),

  console_messages: (args, extra) =>
    runCdp(args, extra, { interacts: false }, (t, tab) => ({
      ok: true,
      ...tab.capture.readConsole({ level: args.level, limit: args.limit, clear: args.clear }),
      capturingSince: tab.capture.startedAt
    })),

  network_requests: (args, extra) =>
    runCdp(args, extra, { interacts: false }, (t, tab) => ({
      ok: true,
      ...tab.capture.readNetwork({
        urlContains: args.url_contains,
        type: args.type,
        failedOnly: args.failed_only,
        limit: args.limit,
        includeHeaders: args.include_headers,
        clear: args.clear
      }),
      capturingSince: tab.capture.startedAt
    }))
};
