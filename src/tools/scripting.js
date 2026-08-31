import { TAB_ID, runPage } from './shared.js';
import { ArcError } from '../jxa.js';

export const tools = [
  {
    name: 'execute_javascript',
    description: 'Run JavaScript in a tab and return the result. A bare expression, or a statement body that uses return, both work. The helper library is available as A (A.all, A.one, A.click, A.setValue, A.describe, A.visible).',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript to evaluate. An expression returns its value; a statement body returns whatever it returns, or null.' },
        tab_id: TAB_ID
      },
      required: ['code']
    },
    annotations: { title: 'Execute JavaScript', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'batch',
    description: 'Run several tools in order in one call, passing the same tab through. Stops at the first failure unless continue_on_error is set. Use this to cut round trips: fill, fill, click, wait.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Steps to run in order',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Name of any other tool in this server' },
              args: { type: 'object', description: 'Arguments for that tool' }
            },
            required: ['tool']
          }
        },
        tab_id: { ...TAB_ID, description: 'Applied to every step that does not set its own' },
        continue_on_error: { type: 'boolean', description: 'Keep going after a failing step', default: false }
      },
      required: ['steps']
    },
    annotations: { title: 'Batch', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }
];

// `batch` needs to call peers, so the registry injects the full handler map.
let lookup = () => ({});
export function bindRegistry(fn) {
  lookup = fn;
}

/** Parse-check a function body in Node. Returns the SyntaxError message, or null. */
function parseError(body) {
  try {
    // Built, never called: constructing it is the parse check.
    new Function('A', body);
    return null;
  } catch (error) {
    return error.message;
  }
}

/**
 * Decide here, in Node, whether the caller's code is an expression or a
 * statement body. Two reasons it cannot be decided in the page: a syntax error
 * in the injected script fails at parse time, so no try/catch in the page can
 * report it and Arc just returns empty, and a page with a strict CSP (GitHub,
 * Google) can block the eval such a check would need.
 * Newlines around the code keep a trailing line comment from eating the `);`.
 */
export function wrapUserCode(code) {
  const expression = `return (\n${code}\n);`;
  if (!parseError(expression)) return { form: 'expression', body: expression };

  const statementError = parseError(code);
  if (!statementError) return { form: 'statement', body: code };

  throw new ArcError(
    `That code does not parse: ${statementError}. It is not a valid expression either, ` +
    'so nothing was sent to Arc.'
  );
}

// Two step results describe the same tab when the id and the url match. Title
// can flap on a single-page app without the step having changed tabs.
const sameTab = (a, b) => !!a && !!b && a.id === b.id && a.url === b.url;

/**
 * The tab state most steps saw, which is the one worth hoisting out of the
 * results. `>=` walks forward, so a tie picks the later state: after a
 * navigation the caller cares about where the batch ended up.
 */
function commonTab(tabs) {
  let best = null;
  let bestCount = 0;
  for (const tab of tabs) {
    const count = tabs.filter((other) => sameTab(other, tab)).length;
    if (count >= bestCount) {
      best = tab;
      bestCount = count;
    }
  }
  return best;
}

function withoutTab(value) {
  if (!value || typeof value !== 'object' || !('tab' in value)) return value;
  const { tab, ...rest } = value;
  return rest;
}

export const handlers = {
  execute_javascript: async (args) => {
    const { form, body } = wrapUserCode(args.code);
    const { result, note, tab } = await runPage(args, body);
    // A statement body yields a value only through `return`, so an empty result
    // there is worth explaining rather than reporting as a bare null.
    const needsReturn = result === undefined && form === 'statement' && !/\breturn\b/.test(args.code);
    const hint = needsReturn
      ? 'Ran as a statement body, which produces a value only through `return`. Add one to get a result back.'
      : null;
    return {
      ok: true,
      // Says which wrapper was chosen, so a null result is never a mystery.
      form,
      result: result === undefined ? null : result,
      ...(note || hint ? { note: note || hint } : {}),
      tab
    };
  },

  batch: async (args) => {
    const steps = args.steps || [];
    const all = lookup();
    const ran = [];

    // bindRegistry runs when registry.js is imported. Importing this module on
    // its own leaves batch with no peers, and "Unknown tool: click" is a
    // baffling way to find that out.
    if (Object.keys(all).length === 0) {
      throw new ArcError(
        'batch has no tools to call because the registry was never bound. Import ' +
        'src/registry.js, as src/index.js does, rather than this module on its own.'
      );
    }

    for (const [index, step] of steps.entries()) {
      const handler = all[step.tool];
      if (!handler) {
        ran.push({ index, tool: step.tool, ok: false, error: `Unknown tool: ${step.tool}` });
        if (!args.continue_on_error) break;
        continue;
      }
      const stepArgs = { ...(args.tab_id ? { tab_id: args.tab_id } : {}), ...(step.args || {}) };
      try {
        const value = await handler(stepArgs);
        const failed = value && value.ok === false;
        ran.push({ index, tool: step.tool, ok: !failed, value });
        if (failed && !args.continue_on_error) break;
      } catch (error) {
        ran.push({ index, tool: step.tool, ok: false, error: error.message });
        if (!args.continue_on_error) break;
      }
    }

    // The tab is usually the same for every step, and repeating it (url and
    // all) once per step buried the actual results. Report it once and flag
    // only the steps whose tab really differs.
    const batchTab = commonTab(ran.map((r) => r.value && r.value.tab).filter(Boolean));

    const results = ran.map(({ index, tool, ok, value, error }) => {
      if (error !== undefined) return { index, tool, ok, error };
      const stepTab = value && value.tab;
      const out = { index, tool, ok, result: withoutTab(value) };
      if (stepTab && !sameTab(stepTab, batchTab)) out.tab = stepTab;
      return out;
    });

    return {
      ran: results.length,
      total: steps.length,
      ok: results.every((r) => r.ok),
      ...(batchTab ? { tab: batchTab } : {}),
      results
    };
  }
};
