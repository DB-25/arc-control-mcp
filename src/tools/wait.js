import { ArcError } from '../jxa.js';
import { z, TAB_ID, SELECTOR, timeoutMs, MAX_CALLER_TIMEOUT_MS } from './schema.js';
import { read, runPage, sleep, throwIfCancelled } from './shared.js';

const POLL_MS = 250;
const DEFAULT_WAIT_MS = 10000;
const MAX_NEEDLES = 20;
// How much page text is returned around a hit. Enough to see what matched,
// short enough that a hit inside a long article is not a content dump.
const CONTEXT_CHARS = 60;

export const tools = [
  {
    name: 'wait_for_text',
    description:
      'Poll until any of several strings (or a regular expression) appears in, or disappears from, the visible text of the page or of a scope selector. ' +
      'Use it where wait_for_selector cannot: a status line that changes ("Saved", "Order confirmed"), or a spinner label that goes away. ' +
      'Reads the rendered text, so text in display:none is not seen, and text inside an iframe is not either. ' +
      'Same conventions as wait_for_selector: a bad regex fails straight away, and a timeout says so with waitedMs and what was found on the last poll.',
    input: z.object({
      texts: z
        .array(z.string())
        .max(MAX_NEEDLES)
        .optional()
        .describe('Any one of these strings counts as a match. Case-insensitive unless case_sensitive is set.'),
      regex: z.string().optional().describe('A JavaScript regular expression source, without slashes, matched against the text. Combines with texts: either matches.'),
      state: z.enum(['present', 'absent']).default('present').describe('present waits for a match to appear. absent waits until none of the texts or the regex match.'),
      selector: SELECTOR.describe(
        'Only search the text of elements matching this selector (every match is searched). CSS selector, or "text=Label". Omit to search the whole page.'
      ).optional(),
      case_sensitive: z.boolean().default(false).describe('Match case exactly'),
      tab_id: TAB_ID.optional(),
      timeout_ms: timeoutMs(DEFAULT_WAIT_MS, 'Give up after this long.')
    }),
    annotations: read('Wait For Text')
  }
];

// Exported for unit tests; not part of the tool surface.
export function needlesFrom(args) {
  const texts = args.texts ?? [];
  if (texts.length === 0 && args.regex === undefined) {
    throw new ArcError('wait_for_text needs texts, regex, or both. With neither there is nothing to wait for.');
  }
  if (texts.some((t) => t === '')) {
    throw new ArcError('An empty string is in texts, and it matches every page. Remove it.');
  }
  if (args.regex !== undefined) {
    try {
      new RegExp(args.regex);
    } catch (error) {
      throw new ArcError(`regex does not compile: ${error.message}`);
    }
    if (args.regex === '') throw new ArcError('An empty regex matches every page. Give it a pattern.');
  }
  return { texts, regex: args.regex ?? null };
}

// Runs in the page. Reports which needle matched first rather than every one,
// because a wait only needs to know whether the condition holds.
// Exported for unit tests too.
export const searchScript = ({ texts, regex }, args) => `
  var scope = ${JSON.stringify(args.selector ?? null)};
  var parts = [];
  var scopeMatches = null;
  if (scope) {
    var els = A.all(scope);
    scopeMatches = els.length;
    for (var i = 0; i < els.length; i++) parts.push(els[i].innerText || els[i].textContent || '');
  } else {
    parts.push((document.body ? document.body.innerText : document.documentElement.textContent) || '');
  }
  var hay = parts.join('\\n');
  var sensitive = ${args.case_sensitive === true};
  var folded = sensitive ? hay : hay.toLowerCase();
  var texts = ${JSON.stringify(texts)};
  var hit = null;
  for (var t = 0; t < texts.length && !hit; t++) {
    var needle = sensitive ? texts[t] : texts[t].toLowerCase();
    var at = folded.indexOf(needle);
    if (at >= 0) hit = { matched: texts[t], at: at, length: needle.length };
  }
  var source = ${JSON.stringify(regex)};
  if (!hit && source !== null) {
    var m = new RegExp(source, sensitive ? '' : 'i').exec(hay);
    if (m) hit = { matched: '/' + source + '/', at: m.index, length: m[0].length };
  }
  var out = { found: !!hit, scopeMatches: scopeMatches, textLength: hay.length };
  if (hit) {
    out.matched = hit.matched;
    out.context = hay.slice(Math.max(0, hit.at - ${CONTEXT_CHARS}), hit.at + hit.length + ${CONTEXT_CHARS}).replace(/\\s+/g, ' ').trim();
  }
  return out;`;

export const handlers = {
  // A page error (a throwing selector) is left to propagate, for the same
  // reason as wait_for_selector: it would fail identically on every poll.
  wait_for_text: async (args, extra) => {
    const needles = needlesFrom(args);
    const timeout = Math.min(args.timeout_ms ?? DEFAULT_WAIT_MS, MAX_CALLER_TIMEOUT_MS);
    const want = args.state || 'present';
    const script = searchScript(needles, args);
    const started = Date.now();
    let last = null;

    while (Date.now() - started < timeout) {
      throwIfCancelled(extra);
      const { result, tab } = await runPage(args, script, Math.max(timeout - (Date.now() - started), 1500));
      last = { ...result, tab };
      if ((want === 'present') === result.found) {
        const out = { ok: true, state: want, waitedMs: Date.now() - started, ...last };
        // Absent inside a scope that does not exist is true, but not for the
        // reason the caller probably hoped, so say so.
        if (want === 'absent' && result.scopeMatches === 0) {
          out.note = `Nothing matches the scope selector ${args.selector}, so there was no text to find. If you expected that element to exist, this is not the confirmation you wanted.`;
        }
        return out;
      }
      await sleep(POLL_MS);
    }
    return {
      ok: false,
      timedOut: true,
      state: want,
      waitedMs: Date.now() - started,
      ...last,
      note: want === 'present'
        ? `None of the texts${needles.regex ? ' or the regex' : ''} appeared within ${timeout}ms${last?.scopeMatches === 0 ? `, and nothing matches the scope selector ${args.selector}` : ''}.`
        : `The text was still on the page after ${timeout}ms (matched: ${last?.matched}).`
    };
  }
};
