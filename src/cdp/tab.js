/**
 * What every CDP operation needs from one attached tab: a bound `send`, page
 * evaluation with the shared selector helpers, input dispatch that reports a
 * dialog instead of hanging, and element lookup that mirrors the click tool.
 */
import { ArcError } from '../jxa.js';
import { PAGE_LIB } from '../page-lib.js';

/** Thrown out of an input call when a JavaScript dialog opened and is blocking the page. */
export class DialogInterrupt extends Error {
  constructor(dialog) {
    super('A JavaScript dialog opened.');
    this.dialog = dialog;
  }
}

/**
 * Page code for Runtime.evaluate. Unlike the JXA path, which runs in Arc's
 * isolated world, this runs in the page's own world, so the helper library is
 * kept inside a function: a bare `var A` would overwrite a global the page owns.
 */
export function cdpScript(body) {
  return `(function(){${PAGE_LIB}
  try {
    return A.envelope((function(){
${body}
    })());
  } catch (e) { return A.failure(e); }
})()`;
}

export const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

/** Bind an attached tab to one tool call's cancellation signal and timeout. */
export function bindTab(tab, { signal, timeoutMs } = {}) {
  const options = { signal, ...(timeoutMs ? { timeoutMs } : {}) };
  const t = {
    tab,
    capture: tab.capture,
    send: (method, params) => tab.session.send(method, params, options),

    /** Run page code with the A helpers; returns its value or throws the page's own error. */
    async page(body) {
      const out = await t.send('Runtime.evaluate', { expression: cdpScript(body), returnByValue: true });
      if (out.exceptionDetails) {
        throw new ArcError(`The page script failed: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`);
      }
      const envelope = out.result?.value;
      if (!envelope || envelope.__arc !== 1) throw new ArcError('The page returned nothing recognisable to the DevTools evaluation.');
      if (envelope.ok === false) throw new ArcError(`The page script failed: ${envelope.name}: ${envelope.error}`);
      return envelope.v;
    },

    /**
     * Without focus emulation the first input event sent to a background tab
     * stalls for about five seconds (Chrome waits out an acknowledgement that a
     * hidden renderer never sends). With it the tab behaves as focused, which
     * only the page can observe, and input is immediate. Needed once per session.
     */
    async prepareInput() {
      if (tab.focusEmulation) return;
      await t.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      tab.focusEmulation = true;
    },

    /**
     * An input command that does not hang when it opens a dialog. A click whose
     * handler calls alert() does not return until the dialog is dismissed, so
     * the call is raced against the dialog event.
     */
    async input(method, params) {
      const waiter = tab.capture.dialogWaiter();
      const call = t.send(method, params);
      try {
        const dialog = await Promise.race([call.then(() => null), waiter.promise]);
        if (dialog) {
          call.catch(() => {});
          throw new DialogInterrupt(dialog);
        }
      } finally {
        waiter.dispose();
      }
    }
  };
  return t;
}

/** Run input steps, recording a dialog that interrupted them on the result instead of failing. */
export async function withDialog(result, steps) {
  try {
    await steps();
  } catch (error) {
    if (!(error instanceof DialogInterrupt)) throw error;
    result.dialog = error.dialog;
    result.warning = 'A JavaScript dialog opened and is blocking the page. Call handle_dialog to accept or dismiss it before doing anything else.';
  }
  return result;
}

const matchOptions = (exact) => JSON.stringify({ exact: exact === true });

/**
 * Resolve a selector to a point a real pointer could use: scrolled into view
 * and clamped to the visible part of the element. A disabled control is refused
 * when `refuseDisabled`, as the synthetic click tool does.
 */
export async function locate(t, { selector, nth = 0, exact }, { refuseDisabled = false } = {}) {
  const info = await t.page(
    `var els = A.all(${JSON.stringify(selector)}, null, ${matchOptions(exact)});
     var el = els[${nth}];
     if (!el) return { error: 'no_match', matches: els.length };
     var info = { matches: els.length, target: A.describe(el, false), disabled: A.disabled(el), hidden: document.hidden };
     ${refuseDisabled ? "if (info.disabled) return Object.assign({ error: 'disabled' }, info);" : ''}
     el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
     var r = el.getBoundingClientRect();
     if (r.width < 1 || r.height < 1) return Object.assign({ error: 'no_box' }, info);
     var left = Math.max(r.left, 0), right = Math.min(r.right, window.innerWidth);
     var top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight);
     if (right <= left || bottom <= top) return Object.assign({ error: 'offscreen' }, info);
     info.x = (left + right) / 2;
     info.y = (top + bottom) / 2;
     info.rect = { x: r.left, y: r.top, width: r.width, height: r.height };
     info.scroll = { x: window.scrollX, y: window.scrollY };
     info.coveredBy = A.coveredBy(el) || undefined;
     return info;`
  );
  if (!info.error) return { found: info };
  const why = {
    no_match: `No element matches ${selector}`,
    disabled: `${selector} resolves to a disabled <${info.target?.tag}>, so a click would do nothing. Nothing was clicked.`,
    no_box: `${selector} has no size on screen (display none, or zero width or height), so there is nothing to point at.`,
    offscreen: `${selector} cannot be brought into the viewport (it sits inside a clipped or hidden scroller).`
  }[info.error];
  return { failure: fail(why, { matches: info.matches, ...(info.error === 'disabled' ? { control: info.target } : {}) }) };
}
