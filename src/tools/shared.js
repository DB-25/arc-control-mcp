import { runJxa, ArcError } from '../jxa.js';
import * as state from '../state.js';
import { pageScript } from '../page-lib.js';

/**
 * MCP tool annotations. The spec's defaults are counterintuitive:
 * destructiveHint and openWorldHint both default to true, and destructiveHint
 * and idempotentHint are only meaningful when readOnlyHint is false. Every
 * hint is therefore stated rather than left to a client's inference.
 *
 * openWorld defaults to true because almost every tool here touches an
 * arbitrary web page, and untrusted external content is precisely the open
 * world the flag exists to describe. Pass openWorld: false only for tools that
 * read Arc's own tab and space bookkeeping.
 */
export const read = (title, options = {}) => {
  // Same guard as write(): a stale positional argument should crash at import
  // rather than quietly resolve to a default nobody intended.
  if (typeof options !== 'object' || options === null) {
    throw new Error(`read("${title}") takes an options object. Pass { openWorld: false } instead of a boolean.`);
  }
  const { openWorld = true } = options;
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: openWorld
  };
};

export const write = (title, options = {}) => {
  // This used to take a positional boolean. Mislabelling a destructive tool as
  // safe is the worst outcome here, so a stale call site must crash at import
  // rather than quietly resolve to destructive: false.
  if (typeof options !== 'object' || options === null) {
    throw new Error(`write("${title}") takes an options object. Pass { destructive: true } instead of a boolean.`);
  }
  const { destructive = false, idempotent = false, openWorld = true } = options;
  return {
    title,
    readOnlyHint: false,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: openWorld
  };
};

/** Adds the agent's implicit target and ownership info to every script. */
export function scoped(args = {}) {
  // The registry decides per tool whether falling back to the user's active
  // tab is acceptable, and passes it down out of band rather than as a
  // caller-settable argument.
  const { __allowActiveTab, ...rest } = args;
  return {
    ...rest,
    allow_active_tab: __allowActiveTab === true,
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
export function runPage(args, body, timeoutMs) {
  return runJxa(
    `const tab = target();
     JSON.stringify({ result: evalJs(tab, P.page_code), tab: describe(tab) });`,
    scoped({ ...args, page_code: pageScript(body) }),
    timeoutMs
  ).then(unwrapPage);
}

/**
 * Which tab a call would act on, and where it is right now. The guardrails in
 * policy.js use it to vet the target before the handler runs, resolving it with
 * the same rules target() applies.
 */
export function peekTab(args, allowActiveTab) {
  return runJxa(
    `const tab = target(); JSON.stringify({ id: tab.id(), url: tab.url() });`,
    scoped({ ...args, __allowActiveTab: allowActiveTab })
  );
}

/** Same, but for scripts whose value is the whole response. */
export function runTab(args, jxaBody, timeoutMs) {
  return runJxa(jxaBody, scoped(args), timeoutMs);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The spec asks a receiver of notifications/cancelled to stop work and release
 * resources. Each poll spawns an osascript process against the user's Arc, so a
 * loop that ignores the signal keeps prodding their browser for a result nobody
 * will read. extra is absent when a handler is called internally, for instance
 * by batch.
 */
export function throwIfCancelled(extra) {
  if (extra?.signal?.aborted) throw new ArcError('Cancelled by the caller.');
}
export { state };
