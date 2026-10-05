import { ArcError } from '../jxa.js';
import { z, TAB_ID, SELECTOR, VERBOSE, EXACT, NTH, MAX_CALLER_TIMEOUT_MS } from './schema.js';
import { write, runPage, sleep, throwIfCancelled } from './shared.js';

const MAX_FORM_FIELDS = 50;
const MAX_TYPE_CHARS = 2000;
// Per character, in the page. Anything slower than a person typing is not what
// the option is for.
const MAX_TYPE_DELAY_MS = 250;
// A delayed type runs on page timers while Node polls, so the whole thing has
// to end inside the client's request timeout with room for the final read.
const MAX_TYPE_TOTAL_MS = MAX_CALLER_TIMEOUT_MS - 5000;
const TYPE_POLL_MS = 400;
const VALUE_ECHO_CHARS = 500;
// Types where appending one character at a time yields a valid value after
// every step. A number or date input sanitises "1." or "2026-" to "".
const TYPEABLE = '^(text|search|url|tel|email|password)$';

const MATCH_EXACT = EXACT.describe(
  'For "text=" selectors, require the whole trimmed text to equal the label instead of containing it. No effect on CSS selectors.'
);
const matchOpts = (args) => JSON.stringify({ exact: args.exact === true });
const verboseFlag = (args) => String(args.verbose === true);

export const tools = [
  {
    name: 'fill_form',
    description:
      'Fill several fields in one call. Each field is set exactly as fill would set it, with the same checks: a disabled, readonly or non-input target fails with its reason. ' +
      'Fields are all attempted, in order, and every one reports its own result, so a form with one bad selector tells you which and still fills the rest. ' +
      'ok is false when any field failed, and error names them. Values are not echoed back. Does not submit: click the submit button afterwards.',
    input: z.object({
      fields: z
        .array(
          z.object({
            selector: SELECTOR,
            value: z.string().describe('Value to set'),
            nth: NTH.describe('Which match to fill, 0-based'),
            exact: MATCH_EXACT
          })
        )
        .min(1)
        .max(MAX_FORM_FIELDS)
        .describe(`Fields to fill, up to ${MAX_FORM_FIELDS}`),
      tab_id: TAB_ID.optional()
    }),
    annotations: write('Fill Form')
  },
  {
    name: 'hover',
    description:
      'Move a pointer onto an element: pointerover, pointerenter, mouseover, mouseenter, pointermove and mousemove at its center, after scrolling it into view. ' +
      'Opens menus and tooltips that listen for those events. CSS :hover styling is browser state a script cannot set, so a menu driven only by :hover will not open. ' +
      'Like click, it reports coveredBy when another element sits on top of the target at its center.',
    input: z.object({
      selector: SELECTOR,
      tab_id: TAB_ID.optional(),
      nth: NTH.describe('Which match to hover, 0-based'),
      exact: MATCH_EXACT,
      verbose: VERBOSE
    }),
    annotations: write('Hover', { idempotent: true })
  },
  {
    name: 'type',
    description:
      'Type text into an input, textarea or contenteditable one character at a time: keydown, keypress, beforeinput, a native-setter append, input and keyup for each character, appended at the end. ' +
      'Use it for autocomplete and search-as-you-type widgets, which react to per-character events that fill never sends. ' +
      'Afterwards it checks the field: ok is false when characters were not inserted (the page cancelled a key, or maxlength was reached), and the final value is reported (its length only for a password field). ' +
      'Events are synthetic, so a widget that checks event.isTrusted still will not react. Number, date and other non-text inputs are refused: use fill. Newlines and tabs are refused: use press_key.',
    input: z.object({
      selector: SELECTOR,
      text: z.string().describe(`Text to type, up to ${MAX_TYPE_CHARS} characters`),
      tab_id: TAB_ID.optional(),
      nth: NTH.describe('Which match to type into, 0-based'),
      clear: z.boolean().default(false).describe('Empty the field first. Otherwise the text is appended to what is there.'),
      delay_ms: z
        .number()
        .min(0)
        .max(MAX_TYPE_DELAY_MS)
        .default(0)
        .describe(
          `Pause between characters, up to ${MAX_TYPE_DELAY_MS}ms, for widgets that debounce. Runs on page timers, which a background tab throttles to about one per second, so use 0 there or switch_to_tab first. The whole text must fit in ${MAX_TYPE_TOTAL_MS}ms.`
        ),
      exact: MATCH_EXACT
    }),
    annotations: write('Type')
  }
];

// Runs in the page. `got` is what the caller is told about the field.
const FINISH = `
  var finishType = function (job) {
    var now = job.read();
    var out = {
      typed: job.chars.length,
      inserted: job.inserted,
      valueMatches: now === job.expected,
      length: now.length,
      kind: job.kind
    };
    if (job.kind !== 'password') out.value = now.length > ${VALUE_ECHO_CHARS} ? now.slice(0, ${VALUE_ECHO_CHARS}) + '\\u2026' : now;
    return out;
  };`;

// Exported for unit tests; not part of the tool surface.
export function typeScript(args) {
  const delay = args.delay_ms ?? 0;
  return `
    var els = A.all(${JSON.stringify(args.selector)}, null, ${matchOpts(args)});
    var el = els[${args.nth ?? 0}];
    if (!el) return { error: 'no_match', matches: els.length };
    var editable = el.isContentEditable;
    var kind = editable ? { tag: el.tagName.toLowerCase(), type: 'contenteditable' } : A.assertTypable(el);
    if (!editable && kind.type && !/${TYPEABLE}/.test(kind.type)) {
      return { error: 'untypeable', tag: kind.tag, type: kind.type, matches: els.length };
    }
    ${FINISH}
    var read = function () { return editable ? el.textContent : el.value; };
    el.focus();
    if (${args.clear === true}) {
      if (editable) el.textContent = ''; else A.nativeSet(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var text = ${JSON.stringify(args.text)};
    var job = { chars: Array.from(text), inserted: 0, read: read, expected: read() + text, kind: kind.type || kind.tag, done: false, cancelled: false };
    var finish = function () { job.done = true; job.result = finishType(job); return job.result; };
    ${delay === 0
      ? `for (var i = 0; i < job.chars.length; i++) if (A.typeChar(el, job.chars[i])) job.inserted++;
    var sync = finish();
    sync.matches = els.length;
    return sync;`
      : `window.__arcTypeJob = job;
    var step = function (i) {
      if (job.cancelled) { job.result = finishType(job); job.done = true; return; }
      if (i >= job.chars.length) { finish(); return; }
      if (A.typeChar(el, job.chars[i])) job.inserted++;
      job.position = i + 1;
      setTimeout(function () { step(i + 1); }, ${delay});
    };
    step(0);
    return { started: true, matches: els.length, hidden: document.hidden };`}`;
}

const pollScript = (cancel) => `
  var job = window.__arcTypeJob;
  if (!job) return { lost: true };
  ${cancel ? 'job.cancelled = true;' : ''}
  return { done: job.done, position: job.position || 0, result: job.done ? job.result : null };`;

// Exported for unit tests; not part of the tool surface.
export function validateType(args) {
  const chars = Array.from(args.text);
  if (chars.length === 0) throw new ArcError('type needs some text. Use fill with an empty value to clear a field.');
  if (chars.length > MAX_TYPE_CHARS) throw new ArcError(`type takes up to ${MAX_TYPE_CHARS} characters, and this is ${chars.length}. Use fill for a long value.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(args.text)) {
    throw new ArcError('The text has a newline, tab or other control character, which a character-by-character type cannot deliver. Use press_key for Enter or Tab, or fill for a multi-line value.');
  }
  const delay = args.delay_ms ?? 0;
  if (delay * chars.length > MAX_TYPE_TOTAL_MS) {
    throw new ArcError(`${chars.length} characters at ${delay}ms is ${delay * chars.length}ms, over the ${MAX_TYPE_TOTAL_MS}ms one call may take. Type it in pieces, or lower delay_ms.`);
  }
  return { chars: chars.length, delay };
}

/** Wait on the page's own timers for a delayed type, and read its outcome. */
async function awaitTyping(args, expectedMs, extra) {
  const deadline = Date.now() + expectedMs + TYPE_POLL_MS * 2;
  let last = null;
  while (Date.now() < deadline) {
    throwIfCancelled(extra);
    await sleep(TYPE_POLL_MS);
    const { result } = await runPage(args, pollScript(false));
    last = result;
    if (result.lost || result.done) return result;
  }
  // Out of time: stop the page's timer chain so it does not keep typing after we report.
  const { result } = await runPage(args, pollScript(true));
  return { ...result, timedOut: true, position: last?.position ?? result.position };
}

export const handlers = {
  fill_form: async (args) => {
    const { result, tab } = await runPage(
      args,
      `var fields = ${JSON.stringify(args.fields)};
       var out = [];
       for (var i = 0; i < fields.length; i++) {
         var f = fields[i];
         var els = A.all(f.selector, null, { exact: f.exact === true });
         var el = els[f.nth || 0];
         if (!el) { out.push({ index: i, selector: f.selector, ok: false, matches: els.length, error: 'No element matches' }); continue; }
         try {
           A.setValue(el, f.value);
           out.push({ index: i, selector: f.selector, ok: true, matches: els.length, tag: el.tagName.toLowerCase(), type: el.type || null });
         } catch (e) {
           out.push({ index: i, selector: f.selector, ok: false, matches: els.length, error: e && e.message ? String(e.message) : String(e) });
         }
       }
       return out;`
    );
    const failed = result.filter((field) => !field.ok);
    const base = { filled: result.length - failed.length, failed: failed.length, fields: result, tab };
    if (failed.length === 0) return { ok: true, ...base };
    const named = failed.map((f) => `${f.selector} (${f.error})`).join('; ');
    return {
      ok: false,
      error: `${failed.length} of ${result.length} fields failed: ${named}. The others were filled.`,
      ...base
    };
  },

  hover: async (args) => {
    const { result, tab } = await runPage(
      args,
      `var els = A.all(${JSON.stringify(args.selector)}, null, ${matchOpts(args)});
       var el = els[${args.nth ?? 0}];
       if (!el) return { error: 'no_match', matches: els.length };
       // Checked after the scroll and before the events, which may remove an overlay.
       el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
       var cover = A.coveredBy(el);
       A.hover(el);
       return { hovered: A.describe(el, ${verboseFlag(args)}), matches: els.length, coveredBy: cover || undefined };`
    );
    if (result?.error === 'no_match') {
      return { ok: false, error: `No element matches ${args.selector}`, matches: result.matches, tab };
    }
    if (result.coveredBy) {
      result.warning = `${result.coveredBy} sits on top of this element at its center, so a real pointer would hover that instead. The synthetic events still reached the target: check that the menu or tooltip actually appeared.`;
    }
    return { ok: true, ...result, tab };
  },

  type: async (args, extra) => {
    const { chars, delay } = validateType(args);
    const { result, tab } = await runPage(args, typeScript(args));
    if (result?.error === 'no_match') {
      return { ok: false, error: `No element matches ${args.selector}`, matches: result.matches, tab };
    }
    if (result?.error === 'untypeable') {
      return {
        ok: false,
        error: `${args.selector} resolves to <${result.tag} type=${result.type}>, where a character-by-character type cannot build a valid value. Use fill. Nothing was typed.`,
        tab
      };
    }

    let outcome = result;
    let timedOut = false;
    if (result.started) {
      const polled = await awaitTyping(args, delay * chars, extra);
      if (polled.lost) {
        return { ok: false, error: 'The page navigated or reloaded while typing, so the typing was cut short and its result is gone. Check the field.', tab };
      }
      timedOut = polled.timedOut === true;
      outcome = { ...(polled.result ?? {}), matches: result.matches, hidden: result.hidden };
      if (timedOut) outcome.position = polled.position;
    }

    if (timedOut || outcome.inserted < outcome.typed) {
      const cut = timedOut
        ? `Stopped after ${outcome.position ?? 0} of ${chars} characters: the page's timers ran slower than delay_ms${outcome.hidden ? ' (this tab is in the background, where timers are throttled)' : ''}.`
        : `Only ${outcome.inserted} of ${outcome.typed} characters were inserted: the page cancelled a keydown, keypress or beforeinput event for the rest, or the field's maxlength was reached.`;
      return { ok: false, error: cut, ...outcome, tab };
    }
    const note = outcome.valueMatches
      ? undefined
      : 'Every character went in, but the field no longer equals what was there plus the typed text. The page rewrote it: an input mask, an autocomplete suggestion, or a formatter. value shows what it holds now.';
    return { ok: true, ...outcome, ...(note ? { note } : {}), tab };
  }
};
