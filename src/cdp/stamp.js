/**
 * Semantic selectors (ref=, role=, label=, placeholder=) for the DevTools tools.
 *
 * They cannot be resolved on the CDP side: the ref table lives in Arc's
 * isolated scripting world (window.__arcSnap), which a main-world evaluation
 * never sees, and the semantic helpers are not shipped in CDP page scripts. So
 * the Apple Event side resolves the selector with the same library the click
 * tool uses, writes a one-time attribute onto the element it found (the DOM is
 * shared between the two worlds), and the CDP side selects by that attribute.
 */
import { randomBytes } from 'node:crypto';

import { runPage } from '../tools/shared.js';

export const TARGET_ATTRIBUTE = 'data-arc-mcp-target';

const SEMANTIC_SELECTOR = /^(?:ref|role|label|placeholder)=/;

export const isSemantic = (selector) => typeof selector === 'string' && SEMANTIC_SELECTOR.test(selector);

/** The CSS selector that finds exactly the element stamped with this nonce. */
export const stampSelector = (nonce) => `[${TARGET_ATTRIBUTE}="${nonce}"]`;

/**
 * Resolve `selector` in the tab and mark the `nth` match. A stale or unknown
 * ref throws the page's own message (take a new snapshot), exactly as click
 * does. Returns { found: false, matches } when the selector matches too few
 * elements, otherwise { found: true, nonce, selector, matches, reResolved }.
 */
export async function stampTarget(tabId, { selector, nth = 0, exact }, { run = runPage, newNonce = () => randomBytes(8).toString('hex') } = {}) {
  const nonce = newNonce();
  // An explicit id, so the Apple Event cannot drift to a different tab. Any
  // stamp a previous call left behind (the page was blocked by a dialog when
  // it should have been cleaned up) goes first, so they cannot pile up.
  const { result } = await run(
    { tab_id: tabId, __allowActiveTab: true },
    `var old = document.querySelectorAll('[${TARGET_ATTRIBUTE}]');
     for (var i = 0; i < old.length; i++) old[i].removeAttribute(${JSON.stringify(TARGET_ATTRIBUTE)});
     var els = A.all(${JSON.stringify(selector)}, null, ${JSON.stringify({ exact: exact === true })});
     var rr = A.last.reResolved;
     var el = els[${Number(nth) || 0}];
     if (!el) return { matches: els.length };
     el.setAttribute(${JSON.stringify(TARGET_ATTRIBUTE)}, ${JSON.stringify(nonce)});
     return { matches: els.length, reResolved: rr || undefined };`
  );
  if (!(result.matches > (Number(nth) || 0))) return { found: false, matches: result.matches };
  return { found: true, nonce, selector: stampSelector(nonce), matches: result.matches, reResolved: result.reResolved === true };
}

/**
 * Take the stamps off again; false when that did not happen. Skipped while a
 * dialog blocks the page, since the evaluation would only hang; the next
 * stampTarget sweeps up what is left.
 */
export async function clearStamps(t, nonces) {
  if (nonces.length === 0) return true;
  if (t.tab.capture.dialog) return false;
  try {
    await t.send('Runtime.evaluate', {
      expression: `(function(){ var n = ${JSON.stringify(nonces)}; for (var i = 0; i < n.length; i++) { var el = document.querySelector('[${TARGET_ATTRIBUTE}="' + n[i] + '"]'); if (el) el.removeAttribute(${JSON.stringify(TARGET_ATTRIBUTE)}); } })()`,
      returnByValue: true
    });
    return true;
  } catch {
    return false;
  }
}
