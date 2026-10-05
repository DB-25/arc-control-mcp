/**
 * The shared path every CDP tool takes: make sure the port is usable, work out
 * which Arc tab the call means (with the same ownership rules as the rest of the
 * server), find its CDP target through the marker, attach, run, and report.
 */
import { CdpError } from './client.js';
import { CdpUnavailable, engine as defaultEngine, setupInstructions, SECURITY_WARNING } from './engine.js';
import { MARKER_ATTRIBUTE } from './mapping.js';
import { bindTab } from './tab.js';
import { runPage, runTab, state } from '../tools/shared.js';

const TAB_INFO_TIMEOUT_MS = 2000;

/**
 * The seams tests replace: the engine, and the Arc side of tab resolution
 * (which needs a real Arc). Everything else runs as shipped.
 */
export const deps = { engine: defaultEngine, resolveTab: resolveArcTab };

/**
 * Arc side of the mapping. A tool that changes a tab never reaches the user's
 * tab: with no tab_id, target() in the JXA preamble applies the same refusal
 * as every other tool, because __allowActiveTab is false for it.
 */
export async function resolveArcTab(args, ctx, engine) {
  let tabId = args.tab_id;
  if (!tabId) {
    const described = await runTab(args, 'const tab = target(); JSON.stringify(describe(tab));');
    tabId = described.id;
  }
  const markTab = async (nonce) => {
    // An explicit id, so the Apple Event cannot drift to a different tab.
    const { tab } = await runPage(
      { tab_id: tabId, __allowActiveTab: true },
      `document.documentElement.setAttribute(${JSON.stringify(MARKER_ATTRIBUTE)}, ${JSON.stringify(nonce)}); return true;`
    );
    return { url: tab.url };
  };
  return { tabId, targetId: await resolveTarget(engine, tabId, markTab) };
}

/**
 * Tab id to target id. A tab with a dialog open is answered from the cache
 * without touching the page: validating the marker means running page code,
 * which a dialog blocks, and the caller needs to be told about the dialog.
 */
export async function resolveTarget(engine, tabId, markTab) {
  const cached = engine.mapper.cached(tabId);
  if (cached && engine.tabs.get(cached)?.capture.dialog) return cached;
  return engine.mapper.resolve(tabId, markTab);
}

export const unavailable = (error) => ({
  ok: false,
  error: error.message,
  enabled: error.enabled,
  port: error.port,
  ...(error.setup ? { setup: error.setup } : {})
});

const describeDialog = (d) => `${d.type} "${String(d.message).slice(0, 120)}"`;

async function tabInfo(client, targetId, tabId) {
  const info = { id: tabId, mine: state.isOwned(tabId) };
  try {
    const { targetInfo } = await client.send('Target.getTargetInfo', { targetId }, { timeoutMs: TAB_INFO_TIMEOUT_MS });
    return { ...info, title: targetInfo.title, url: targetInfo.url };
  } catch {
    return info;
  }
}

/**
 * Run `fn(t)` against the tab a call resolves to. `interacts` marks tools that
 * need the page to respond: they are refused while a dialog blocks it, since
 * they would only hang. Reading captured buffers does not.
 */
export async function runCdp(args, extra, { interacts = true } = {}, fn) {
  const ctx = { signal: extra?.signal, timeoutMs: args.timeout_ms };
  const { engine } = deps;
  try {
    const client = await engine.connection();
    const { tabId, targetId } = await deps.resolveTab(args, ctx, engine);
    const tab = await engine.attach(targetId, ctx);

    if (interacts && tab.capture.dialog) {
      return {
        ok: false,
        error: `A JavaScript dialog is open on this tab (${describeDialog(tab.capture.dialog)}) and blocks the page, so nothing else can run. Call handle_dialog first.`,
        dialog: tab.capture.dialog,
        tab: await tabInfo(client, targetId, tabId)
      };
    }

    const result = await fn(bindTab(tab, ctx), tab);
    // A dialog that opened as a side effect is reported even by tools that
    // were not looking for one.
    if (!result.dialog && tab.capture.dialog) {
      result.dialog = tab.capture.dialog;
      result.warning ??= `A JavaScript dialog is now open (${describeDialog(tab.capture.dialog)}). Call handle_dialog to accept or dismiss it.`;
    }
    return { ...result, tab: await tabInfo(client, targetId, tabId) };
  } catch (error) {
    if (error instanceof CdpUnavailable) return unavailable(error);
    if (error instanceof CdpError) return cdpFailure(error);
    throw error;
  }
}

export function cdpFailure(error) {
  const hint = {
    timeout: 'The page did not respond in time. A JavaScript dialog may be blocking it (try handle_dialog), or the tab is busy or in the background and not painting.',
    closed: 'The connection to the browser was lost. Arc may have restarted without the debugging flag: run cdp_status.',
    cancelled: 'Cancelled by the caller.'
  }[error.code];
  return { ok: false, error: error.message, ...(hint ? { hint } : {}) };
}

export { setupInstructions, SECURITY_WARNING };
