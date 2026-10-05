import { runPage, sleep } from './shared.js';
import { MAX_SETTLE_MS } from './schema.js';

export const DEFAULT_SETTLE_MS = 300;
// Short enough that a page which is merely slow to respond is not mistaken for
// one that never settles, long enough that the polls are not a busy loop.
const POLL_MS = 100;

/** The quiet window for a call, 0 meaning the caller opted out of waiting. */
export const quietMs = (args) => Math.min(args.settle_ms ?? DEFAULT_SETTLE_MS, MAX_SETTLE_MS);

/** Page code that starts watching the DOM, run before the action itself acts. */
export const watchStart = (args) => `var __watch = ${quietMs(args) > 0 ? 'A.watch()' : 'null'};`;

/**
 * Wait for the DOM to go quiet after a mutating action, and report how long
 * that took. It cannot happen inside the action's own page call: Arc returns
 * from execute javascript synchronously, and blocking there would also freeze
 * the page timers that are meant to react to the action. So the observer is
 * started in the action's call and polled from here. The action has already
 * happened by now, so nothing in this function may turn it into a failure.
 */
export async function settle(tab, token, quiet) {
  if (!token) return {};
  const started = Date.now();
  try {
    for (;;) {
      const finalPoll = Date.now() - started >= MAX_SETTLE_MS;
      const { result } = await runPage(
        { tab_id: tab.id },
        `return A.settleStatus(${JSON.stringify(token)}, ${finalPoll ? 0 : quiet});`
      );
      if (result.lost) {
        return { settledMs: null, settleNote: 'The page navigated, so its DOM could not be watched. Call wait_for_load before reading it.' };
      }
      if (result.done) {
        const settled = result.quietFor >= quiet;
        const out = { settledMs: result.settledMs, settled, mutations: result.mutations };
        if (!settled) out.settleNote = `The DOM was still changing after ${MAX_SETTLE_MS}ms. Take a snapshot or wait_for_selector before trusting what is on screen.`;
        else if (result.hidden && result.mutations === 0) out.settleNote = 'Nothing changed, but this tab is in the background and its timers are throttled, so a delayed update may still arrive.';
        return out;
      }
      await sleep(Math.min(POLL_MS, Math.max(quiet - result.quietFor, 10)));
    }
  } catch (error) {
    return { settledMs: null, settleNote: `The DOM settle check failed (${error.message}). The action itself went through.` };
  }
}
