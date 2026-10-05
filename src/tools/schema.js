/**
 * Zod input schemas. Zod is the single source of truth: the JSON Schema each
 * tool advertises is generated from it in registry.js, and the same schema
 * validates incoming arguments, so the two can never drift apart.
 *
 * Keep `z.number()` rather than `z.number().int()`. The int variant emits
 * Number.MAX_SAFE_INTEGER bounds into the generated schema, which is noise in
 * every tools/list response.
 */
import { z } from 'zod';

export { z };

/** A caller-supplied wait must stay well under a client's 60s request timeout. */
export const MAX_CALLER_TIMEOUT_MS = 30000;

export const TAB_ID = z
  .string()
  .describe("Arc tab id from list_tabs. Omit to use this agent's current tab. A tool that changes a tab will not fall back to the tab the user is looking at, so pass this or call open_url first.");

export const SELECTOR = z
  .string()
  .describe(
    'CSS selector, or one of: "text=Some label" (visible text, case-insensitive substring, exact matches ranked first); ' +
    '"ref=e12" (a ref from snapshot, re-resolved if the page re-rendered); ' +
    '"role=button[name="Save"]" (ARIA or implicit role, name an exact match, or name~="sav" for a substring); ' +
    '"label=Email" (the control a label names); "placeholder=Search"'
  );

export const VERBOSE = z
  .boolean()
  .default(false)
  .describe('Include the bulky element rect and longer attribute values');

export const EXACT = z
  .boolean()
  .default(false)
  .describe('For "text=", "label=" and "placeholder=" selectors, require the whole text to match rather than a substring');

export const NTH = z
  .number()
  .default(0)
  .describe('Which match to act on when several exist, 0-based');

/** The longest a mutating action waits for the page to go quiet afterwards. */
export const MAX_SETTLE_MS = 1500;

export const SETTLE_MS = z
  .number()
  .min(0)
  .max(MAX_SETTLE_MS)
  .default(300)
  .describe(
    `After acting, wait until the page's DOM has been quiet for this many ms, then report settledMs. 0 skips the wait. The whole wait is capped at ${MAX_SETTLE_MS}ms; a page that never goes quiet reports settled false.`
  );

/** Every wait shares one ceiling, advertised so a client can see it up front. */
export const timeoutMs = (defaultMs, note) =>
  z
    .number()
    .max(MAX_CALLER_TIMEOUT_MS)
    .default(defaultMs)
    .describe(
      `${note} Capped at ${MAX_CALLER_TIMEOUT_MS}ms so the call cannot outlive a client's request timeout. To wait longer, call this again.`
    );
