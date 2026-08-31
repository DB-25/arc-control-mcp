import { runJxa, ArcError } from '../jxa.js';
import * as state from '../state.js';
import { pageScript } from '../page-lib.js';

export const TAB_ID = {
  type: 'string',
  description: "Arc tab id from list_tabs. Omit to use this agent's current tab, falling back to whatever tab is active in Arc."
};

export const SELECTOR = {
  type: 'string',
  description: 'CSS selector, or "text=Some label" to match on visible text (substring, exact matches ranked first)'
};

export const VERBOSE = {
  type: 'boolean',
  description: 'Include the bulky element rect and longer attribute values',
  default: false
};

export const read = (title) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
export const write = (title, destructive = false) => ({ title, readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false });

/** Adds the agent's implicit target and ownership info to every script. */
export function scoped(args = {}) {
  return {
    ...args,
    default_tab_id: state.currentTabId(),
    agent_space: state.AGENT_SPACE,
    owned_ids: state.ownedIds()
  };
}

/**
 * Turn a page envelope into a plain value, or raise the page's own error.
 * Without this a thrown page script arrives as `null` and every handler
 * spreads it into a cheerful `{ ok: true }`.
 */
export function unwrapPage(out) {
  const { result, tab } = out || {};
  if (!result || result.__arc !== 1) {
    throw new ArcError(
      'The page script returned nothing recognisable. Arc may be blocking JavaScript from Apple ' +
      'Events (Arc > Settings > Advanced > "Allow JavaScript from Apple Events"), or the tab ' +
      'navigated while the call was in flight.'
    );
  }
  if (result.ok === false) {
    throw new ArcError(`The page script failed: ${result.name}: ${result.error}`);
  }
  return { result: result.v, note: result.note, tab };
}

/** Resolve a tab, run DOM code in it, and return the value plus tab info. */
export function runPage(args, body) {
  return runJxa(
    `const tab = target();
     JSON.stringify({ result: evalJs(tab, P.page_code), tab: describe(tab) });`,
    scoped({ ...args, page_code: pageScript(body) })
  ).then(unwrapPage);
}

/** Same, but for scripts whose value is the whole response. */
export function runTab(args, jxaBody, timeoutMs) {
  return runJxa(jxaBody, scoped(args), timeoutMs);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export { state };
