import { ArcError } from '../jxa.js';
import { z, TAB_ID, SELECTOR, VERBOSE, EXACT, NTH, SETTLE_MS, timeoutMs, MAX_CALLER_TIMEOUT_MS } from './schema.js';
import { write, read, runPage, sleep } from './shared.js';
import { quietMs, watchStart, settle } from './settle.js';

const POLL_MS = 250;
const DEFAULT_WAIT_MS = 10000;
// An MCP client abandons a request after 60s (the SDK's own default), and once
// it does, the timedOut payload with waitedMs and the last counts is thrown
// away. So a caller-supplied wait is capped well inside that ceiling, by the
// MAX_CALLER_TIMEOUT_MS that schema.js holds for every waiting tool. Progress
// notifications would not buy more time: a client MAY reset its clock on
// progress and mostly does not.
const DEFAULT_SCROLL_PX = 800;
const MAX_OPTIONS_LISTED = 25;
const TARGET_ATTR_CHARS = 80;

// The shared exact flag, narrowed to the wording these tools have always
// advertised: the "no effect on CSS selectors" half is what stops a model
// passing it blind and then wondering why nothing changed.
const MATCH_EXACT = EXACT.describe(
  'For "text=", "label=" and "placeholder=" selectors, require the whole trimmed text to equal the label instead of containing it. No effect on CSS, ref= or role= selectors.'
);

// Both are interpolated straight into page scripts, so they have to be literals.
const matchOpts = (args) => JSON.stringify({ exact: args.exact === true });
const verboseFlag = (args) => String(args.verbose === true);

// A ref that cannot be found is not a "no match": the caller needs to know it
// is stale and that a new snapshot is the fix. wait_for_selector asks for the
// soft form because an absent or not-yet-back element is a legitimate answer.
const softOpts = (args) => JSON.stringify({ exact: args.exact === true, soft: true });

/** Settle the DOM after a successful action and fold the outcome into its result. */
async function withSettle(args, result, tab) {
  const { watch, ...rest } = result;
  return { ok: true, ...rest, ...(await settle(tab, watch, quietMs(args))), tab };
}

/**
 * The spec asks a receiver of notifications/cancelled to stop work and release
 * resources. Each poll spawns an osascript process against the user's Arc, so a
 * loop that ignores the signal keeps prodding their browser for a result nobody
 * will read. extra is absent when a handler is called internally, for instance
 * by batch.
 */
function throwIfCancelled(extra) {
  if (extra?.signal?.aborted) throw new ArcError('Cancelled by the caller.');
}

/**
 * A page usually enables a control after another step. In a background tab
 * that step may never come: pages that load a widget's code only once it is on
 * screen (IntersectionObserver, loading="lazy") never see it come into view.
 * Found on GitHub's "Save pins" button, which its own script enables.
 */
function disabledHint(isHidden) {
  const base = 'The page enables it after another step, such as a form change or a script loading. Do that step first, then check "disabled" with query_elements before clicking again.';
  if (!isHidden) return base;
  return `${base} This tab is in the background (document.hidden), so code a page loads only once it is on screen may never run: switch_to_tab and retry if it stays disabled.`;
}

const TEXT_NOTE =
  '"text=Label" matches on visible text as a substring, with exact matches ranked first and visible elements ahead of hidden ones, so a short label also matches longer ones. ' +
  'Check the returned "matches" count, and pass exact when it is above 1. ' +
  'Also accepts "ref=e12" from snapshot (re-resolved and reported as reResolved when the page re-rendered, a clear stale-ref failure when the element is truly gone), "role=button[name=\"Save\"]", "label=Email" and "placeholder=Search".';

const SETTLE_NOTE =
  ' On success it waits for the page to go quiet and reports settledMs (and settled false if the DOM was still changing at the cap), so the next read sees the result of the action.';

export const tools = [
  {
    name: 'click',
    description:
      'Click an element. Accepts a CSS selector or "text=Label". Scrolls it into view and dispatches a real pointer sequence, so framework handlers fire. ' +
      TEXT_NOTE +
      ' Returns urlBefore, the url as it was immediately before the click: the tab snapshot can be taken before a navigation settles, so follow with wait_for_load when the click navigates.' +
      ' A match inside a control (a label span in a button) is checked against that control, returned as "control": a disabled one fails with ok false and nothing is clicked.' +
      ' When another element (a modal backdrop, an overlay) covers the target, or it has pointer-events none, the click still goes through but the result carries coveredBy and a warning.' +
      SETTLE_NOTE,
    input: z.object({
      selector: SELECTOR,
      tab_id: TAB_ID.optional(),
      nth: NTH.describe('Which match to click when several exist, 0-based. For text= selectors the order is exact matches first, then substring matches, visible before hidden within each, then DOM order.'),
      exact: MATCH_EXACT,
      settle_ms: SETTLE_MS,
      verbose: VERBOSE
    }),
    annotations: write('Click')
  },
  {
    name: 'fill',
    description:
      'Set the value of an input, textarea or contenteditable. Uses the native setter and fires input and change, so React and similar frameworks register it. ' +
      'Fails with an error naming the tag when the target cannot be filled: a heading or other non-input, a disabled or readonly field, a checkbox, radio or button (use click), a <select> (use select_option), or a field that rejects the value (a number input given text). ' +
      TEXT_NOTE +
      SETTLE_NOTE,
    input: z.object({
      selector: SELECTOR,
      value: z.string().describe('Value to set'),
      tab_id: TAB_ID.optional(),
      nth: NTH.describe('Which match to fill, 0-based'),
      submit: z
        .boolean()
        .default(false)
        .describe(
          'Press Enter, then submit the form if the page did not. Fails with ok false when nothing was submitted, or when the form fails its own validation (the invalid fields are listed). The tab usually navigates, so follow with wait_for_load: the returned tab snapshot may predate the navigation, and urlBefore reports the url from just before the key press.'
        ),
      exact: MATCH_EXACT,
      settle_ms: SETTLE_MS,
      verbose: VERBOSE
    }),
    annotations: write('Fill Field')
  },
  {
    name: 'select_option',
    description:
      'Choose an option in a select element, by exact option value or exact visible label. A disabled select or option fails rather than being set. ' +
      'When nothing matches, the failure lists the options that do exist, so the next call can pick a real one.' +
      SETTLE_NOTE,
    input: z.object({
      selector: SELECTOR.describe('CSS selector, ref=e12 or role=combobox[name="Country"] for the <select>. "text=" cannot reach a select element.'),
      option: z.string().describe('Option value or visible text, matched exactly after trimming'),
      tab_id: TAB_ID.optional(),
      settle_ms: SETTLE_MS
    }),
    annotations: write('Select Option')
  },
  {
    name: 'press_key',
    description:
      'Dispatch a key press to an element, or to the focused element when no selector is given. Handles named keys (Enter, Escape, Tab, ArrowDown) and single printable characters; an unknown name fails. ' +
      'Only the page\'s own key handlers react: a synthetic key types no character, moves no focus and submits no form. defaultPrevented says whether a handler took it. To type, use fill. ' +
      'Returns only a minimal identity for the element that received the key (tag plus whichever of id, name, type and aria-label exist); use query_elements when you need the full picture.' +
      SETTLE_NOTE,
    input: z.object({
      key: z.string().describe('Key name, for example Enter, Escape, Tab, ArrowDown, or a single printable character'),
      selector: SELECTOR.optional(),
      tab_id: TAB_ID.optional(),
      exact: MATCH_EXACT,
      settle_ms: SETTLE_MS
    }),
    annotations: write('Press Key')
  },
  {
    name: 'scroll',
    description: 'Scroll the page, or scroll an element into view. Page scrolls report scrollY, pageHeight and viewport, so you can tell how much is left.',
    input: z.object({
      tab_id: TAB_ID.optional(),
      selector: SELECTOR.describe(
        'Scroll this element into view instead of scrolling the page. CSS selector, or "text=Label" (substring, exact matches ranked first).'
      ).optional(),
      direction: z.enum(['down', 'up', 'top', 'bottom']).default('down').describe('Page scroll direction'),
      amount: z.number().default(DEFAULT_SCROLL_PX).describe('Pixels to scroll for up and down'),
      exact: MATCH_EXACT,
      verbose: VERBOSE
    }),
    annotations: write('Scroll', { idempotent: true })
  },
  {
    name: 'wait_for_selector',
    description:
      'Poll until an element appears, becomes visible, or disappears. Use after a click that loads content. ' +
      'On timeout it says so explicitly with waitedMs and the last counts, and a broken selector or page error fails straight away instead of burning the whole timeout. ' +
      'The visible state ignores screen-reader clipping (boxes under 2x2 px, inset clip-path), which nothing can actually click.',
    input: z.object({
      selector: SELECTOR,
      tab_id: TAB_ID.optional(),
      state: z.enum(['present', 'visible', 'absent']).default('visible').describe('Condition to wait for. A ref that is gone counts as absent.'),
      timeout_ms: timeoutMs(DEFAULT_WAIT_MS, 'Give up after this long. Every call returns the current counts, so repeated short waits tell you more than one long one.'),
      exact: MATCH_EXACT,
      verbose: VERBOSE
    }),
    annotations: read('Wait For Selector')
  }
];

export const handlers = {
  click: async (args) => {
    const { result, tab } = await runPage(
      args,
      `${watchStart(args)}
       var els = A.all(${JSON.stringify(args.selector)}, null, ${matchOpts(args)});
       var rr = A.last.reResolved;
       var el = els[${args.nth ?? 0}];
       if (!el) return { error: 'no_match', matches: els.length };
       var control = A.control(el);
       var target = control === el ? undefined : A.describe(control, ${verboseFlag(args)});
       if (A.disabled(el)) return { error: 'disabled', control: A.describe(control, ${verboseFlag(args)}), matches: els.length, hidden: document.hidden };
       var before = location.href;
       // Checked before the click, which may well remove the overlay or the element.
       el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
       var cover = A.coveredBy(el);
       A.click(el);
       return { clicked: A.describe(el, ${verboseFlag(args)}), control: target, matches: els.length, urlBefore: before, coveredBy: cover || undefined, reResolved: rr || undefined, watch: __watch };`
    );
    if (result?.error === 'no_match') {
      return { ok: false, error: `No element matches ${args.selector}`, matches: result.matches, tab };
    }
    if (result?.error === 'disabled') {
      return {
        ok: false,
        error: `${args.selector} resolves to a disabled <${result.control.tag}>, so a click would do nothing. Nothing was clicked.`,
        hint: disabledHint(result.hidden),
        control: result.control,
        matches: result.matches,
        tab
      };
    }
    if (result?.coveredBy) {
      result.warning = `${result.coveredBy} sits on top of this element at its center, so a user could not click it. The synthetic click still reached it: check that something actually happened.`;
    }
    return withSettle(args, result, tab);
  },

  // A.setValue throws for anything unfillable and runPage turns that into an
  // ArcError naming the tag, so there is deliberately no catch here: only a
  // genuinely absent selector gets the soft failure below.
  fill: async (args) => {
    const submit = args.submit === true;
    const { result, tab } = await runPage(
      args,
      `${watchStart(args)}
       var els = A.all(${JSON.stringify(args.selector)}, null, ${matchOpts(args)});
       var rr = A.last.reResolved;
       var el = els[${args.nth ?? 0}];
       if (!el) return { error: 'no_match', matches: els.length };
       A.setValue(el, ${JSON.stringify(args.value)});
       // Describe before submitting, so filled.value shows what landed even if
       // the form resets or navigates.
       var out = { filled: A.describe(el, ${verboseFlag(args)}), matches: els.length, reResolved: rr || undefined, watch: __watch };
       ${submit
         ? `out.urlBefore = location.href;
       // Watch for a real submit: the page's own Enter handler may submit, and
       // then a second requestSubmit would send the form twice.
       var seen = false;
       var watch = function () { seen = true; };
       document.addEventListener('submit', watch, true);
       A.key(el, 'Enter');
       if (!seen && el.form) {
         if (!el.form.checkValidity()) {
           out.invalid = Array.prototype.slice.call(el.form.elements).filter(function (f) { return f.willValidate && !f.validity.valid; })
             .slice(0, 10).map(function (f) { return { name: f.name || f.id || f.tagName.toLowerCase(), message: f.validationMessage }; });
         } else {
           el.form.requestSubmit();
         }
       }
       document.removeEventListener('submit', watch, true);
       out.submitted = seen;
       out.hasForm = !!el.form;`
         : ''}
       return out;`
    );
    if (result?.error === 'no_match') {
      return { ok: false, error: `No element matches ${args.selector}`, matches: result.matches, tab };
    }
    if (submit && result.invalid) {
      return { ok: false, error: 'The form failed its own validation, so it was not submitted. The field was filled.', ...result, tab };
    }
    if (submit && !result.submitted) {
      const why = result.hasForm
        ? 'Enter and requestSubmit produced no submit event.'
        : 'The field is not in a <form> and no page handler submitted on Enter. Click the page\'s submit button instead.';
      return { ok: false, error: `Filled, but nothing was submitted. ${why}`, ...result, tab };
    }
    const settled = await withSettle(args, result, tab);
    if (submit) return { ...settled, note: 'The tab may still be navigating. Call wait_for_load before reading the page.' };
    return settled;
  },

  select_option: async (args) => {
    const { result, tab } = await runPage(
      args,
      `${watchStart(args)}
       var el = A.one(${JSON.stringify(args.selector)});
       var rr = A.last.reResolved;
       if (!el) return { error: 'no_match' };
       var tag = el.tagName.toLowerCase();
       if (tag !== 'select') return { error: 'not_select', tag: tag };
       if (el.matches(':disabled')) return { error: 'disabled_select' };
       var want = ${JSON.stringify(args.option)};
       var chosen = null;
       for (var i = 0; i < el.options.length; i++) {
         var o = el.options[i];
         if (o.value === want || (o.text || '').trim() === want) {
           // A user cannot pick a disabled option, and the page will not expect one.
           if (o.disabled || (o.parentElement && o.parentElement.disabled)) return { error: 'disabled_option', text: (o.text || '').trim() };
           el.selectedIndex = i;
           chosen = { value: o.value, text: (o.text || '').trim() };
           break;
         }
       }
       if (!chosen) {
         // Listing what is there turns a dead end into a recoverable next call.
         var available = [];
         for (var j = 0; j < el.options.length && j < ${MAX_OPTIONS_LISTED}; j++) {
           available.push({ value: el.options[j].value, text: (el.options[j].text || '').trim() });
         }
         return { error: 'no_option', available: available, total: el.options.length };
       }
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));
       return { selected: chosen, reResolved: rr || undefined, watch: __watch };`
    );
    if (result?.error === 'no_match') return { ok: false, error: `No element matches ${args.selector}`, tab };
    if (result?.error === 'not_select') {
      return {
        ok: false,
        error: `Selector ${args.selector} resolves to <${result.tag}>, not <select>. Use fill for a text input, or click for a custom dropdown.`,
        tab
      };
    }
    if (result?.error === 'disabled_select') {
      return { ok: false, error: `The <select> at ${args.selector} is disabled, so nothing was selected.`, tab };
    }
    if (result?.error === 'disabled_option') {
      return { ok: false, error: `The option "${result.text}" is disabled, so it was not selected.`, tab };
    }
    if (result?.error === 'no_option') {
      return {
        ok: false,
        error: `No option in ${args.selector} has the value or visible text "${args.option}". Pick one from available, which lists ${result.available.length} of the ${result.total} real options with their value and text.`,
        available: result.available,
        total: result.total,
        tab
      };
    }
    return withSettle(args, result, tab);
  },

  press_key: async (args) => {
    const { result, tab } = await runPage(
      args,
      `${watchStart(args)}
       var sel = ${JSON.stringify(args.selector || null)};
       var el = sel ? A.one(sel, 0, ${matchOpts(args)}) : (document.activeElement || document.body);
       var rr = sel ? A.last.reResolved : false;
       if (!el) return { error: 'no_match' };
       var prevented = A.key(el, ${JSON.stringify(args.key)});
       // Identity only: a full describe of a fallback document.body would drag
       // the page's entire innerText into the response.
       var target = { tag: el.tagName.toLowerCase() };
       var names = ['id', 'name', 'type', 'aria-label'];
       for (var i = 0; i < names.length; i++) {
         var v = el.getAttribute(names[i]);
         if (v) target[names[i]] = v.slice(0, ${TARGET_ATTR_CHARS});
       }
       return { key: ${JSON.stringify(args.key)}, target: target, usedFocusedElement: !sel, defaultPrevented: prevented, reResolved: rr || undefined, watch: __watch };`
    );
    if (result?.error === 'no_match') {
      // Without a selector the miss means the document had nothing to aim at.
      const why = args.selector
        ? `No element matches ${args.selector}`
        : 'The page has no focused element and no body to fall back to.';
      return { ok: false, error: why, tab };
    }
    return withSettle(args, result, tab);
  },

  scroll: async (args) => {
    const { result, tab } = await runPage(
      args,
      `var sel = ${JSON.stringify(args.selector || null)};
       if (sel) {
         var el = A.one(sel, 0, ${matchOpts(args)});
         if (!el) return { error: 'no_match' };
         el.scrollIntoView({ block: 'center' });
         return { scrolledTo: A.describe(el, ${verboseFlag(args)}), reResolved: A.last.reResolved || undefined };
       }
       var dir = ${JSON.stringify(args.direction || 'down')};
       var amount = ${args.amount ?? DEFAULT_SCROLL_PX};
       if (dir === 'top') window.scrollTo(0, 0);
       else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
       else window.scrollBy(0, dir === 'up' ? -amount : amount);
       return { scrollY: window.scrollY, pageHeight: document.body.scrollHeight, viewport: window.innerHeight };`
    );
    if (result?.error === 'no_match') return { ok: false, error: `No element matches ${args.selector}`, tab };
    return { ok: true, ...result, tab };
  },

  // runPage throws on a page-script failure, and that is left to propagate: a
  // bad selector is a bad selector on every poll, so retrying it to the
  // deadline would only turn a clear error into a vague timeout.
  wait_for_selector: async (args, extra) => {
    const timeout = Math.min(args.timeout_ms ?? DEFAULT_WAIT_MS, MAX_CALLER_TIMEOUT_MS);
    const want = args.state || 'visible';
    const started = Date.now();
    let last = null;

    while (Date.now() - started < timeout) {
      throwIfCancelled(extra);
      const { result, tab } = await runPage(
        args,
        `var els = A.all(${JSON.stringify(args.selector)}, null, ${softOpts(args)});
         var vis = 0;
         for (var i = 0; i < els.length; i++) if (A.visible(els[i])) vis++;
         return { count: els.length, visible: vis, staleRef: A.last.stale || undefined, reResolved: A.last.reResolved || undefined, first: els[0] ? A.describe(els[0], ${verboseFlag(args)}) : null };`,
        // Bound the probe by what is left, so a wedged call cannot push the
        // tool past the client's timeout.
        Math.max(timeout - (Date.now() - started), 1500)
      );
      last = { ...result, tab };
      const done =
        (want === 'present' && result.count > 0) ||
        (want === 'visible' && result.visible > 0) ||
        (want === 'absent' && result.count === 0);
      if (done) return { ok: true, state: want, waitedMs: Date.now() - started, ...last };
      await sleep(POLL_MS);
    }
    return {
      ok: false,
      timedOut: true,
      state: want,
      waitedMs: Date.now() - started,
      ...last,
      note: `Selector "${args.selector}" was not ${want} within ${timeout}ms.` +
        (last?.staleRef ? ` Ref ${last.staleRef} is stale or unknown: take a new snapshot.` : '')
    };
  }
};
