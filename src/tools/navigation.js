import { ArcError, runJxa } from '../jxa.js';
import { z, TAB_ID, timeoutMs, MAX_CALLER_TIMEOUT_MS } from './schema.js';
import { read, write, scoped, runTab, runPage, unwrapPage, sleep, state } from './shared.js';
import { pageScript } from '../page-lib.js';

const POLL_MS = 250;
const LOAD_TIMEOUT_MS = 15000;
// An MCP client gives up on a request after 60s (the SDK's own default), and a
// call that outlives that loses its result: the caller sees RequestTimeout
// instead of the tab that opened fine, or the timedOut payload that explains
// what the page was doing. So open_url's launch budget plus the longest load
// wait it can be asked for has to stay clearly inside 60s. Progress
// notifications do not help: a client MAY reset its clock on progress and
// mostly does not, so the budget itself is the fix. The ceiling on that wait is
// MAX_CALLER_TIMEOUT_MS, which schema.js holds for every waiting tool.
const OPEN_TIMEOUT_MS = 25000;
// A back, forward or reload commits in well under a second. Giving the move
// check a short budget of its own means "there is no entry that way" answers
// quickly instead of burning the whole load timeout on a tab that never moved.
const MOVE_TIMEOUT_MS = 5000;

// Every caller-supplied wait goes through here, so no argument can push a call
// past the client's deadline.
const loadTimeout = (args) => Math.min(args.timeout_ms ?? LOAD_TIMEOUT_MS, MAX_CALLER_TIMEOUT_MS);

// Capped so a missing history entry answers fast, but never longer than the
// caller asked to wait in total.
const moveTimeout = (args) => Math.min(loadTimeout(args), MOVE_TIMEOUT_MS);

// Every tool here navigates, so they all take the same waiting controls.
const WAIT_OPTIONS = {
  wait_until_loaded: z.boolean().default(true).describe('Wait for the page to finish loading before returning'),
  timeout_ms: timeoutMs(LOAD_TIMEOUT_MS, 'How long to wait for loading.')
};

/**
 * The spec asks a receiver of notifications/cancelled to stop work and release
 * resources. Every poll here spawns an osascript process against the user's
 * Arc, so a loop that ignores the signal keeps prodding their browser for a
 * result nobody will read. extra is absent when a handler is called internally,
 * for instance by batch.
 */
function throwIfCancelled(extra) {
  if (extra?.signal?.aborted) throw new ArcError('Cancelled by the caller.');
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    throw new ArcError(`Not a valid URL: ${url}. Include a scheme, for example https://`);
  }
}

export const tools = [
  {
    name: 'open_url',
    description: 'Open a URL in Arc. Launches Arc if needed. New tabs go into the agent space when one exists, otherwise the main window. Arc auto-selects new tabs, so the previous selection is put back unless you pass activate.',
    input: z.object({
      url: z.string().describe('URL to open'),
      new_tab: z.boolean().default(true).describe('Open a new tab. Set false to navigate an existing tab instead.'),
      tab_id: TAB_ID.describe('With new_tab false, the tab to navigate. Required in that mode unless this agent already has a tab of its own, since navigating the tab the user is looking at is refused.').optional(),
      space: z.string().describe('Space id or title to open into, overriding the agent space').optional(),
      little_arc: z.boolean().default(false).describe('Open a Little Arc window. Fire and forget: Arc does not expose these afterwards.'),
      activate: z.boolean().default(false).describe('Bring Arc to the front and leave the new tab selected'),
      ...WAIT_OPTIONS
    }),
    annotations: write('Open URL')
  },
  {
    name: 'go_back',
    description: "Navigate a tab back in history. Goes through the page, so it works on a background tab, which Arc's own back command does not, and the result is checked against the tab url rather than assumed.",
    input: z.object({ tab_id: TAB_ID.optional(), ...WAIT_OPTIONS }),
    annotations: write('Go Back')
  },
  {
    name: 'go_forward',
    description: 'Navigate a tab forward in history. Goes through the page and confirms the tab really moved before reporting success.',
    input: z.object({ tab_id: TAB_ID.optional(), ...WAIT_OPTIONS }),
    annotations: write('Go Forward')
  },
  {
    name: 'reload_tab',
    description:
      'Reload a tab, then confirm the document really was replaced rather than assume it. Works on a background tab. ' +
      'Takes wait_until_loaded and timeout_ms like the other navigating tools, and returns from, to and the tab. ' +
      'Fails with ok false when the tab is still showing the document that was there before, which is what a slow server or a page holding on to unload looks like from outside.',
    input: z.object({ tab_id: TAB_ID.optional(), ...WAIT_OPTIONS }),
    annotations: write('Reload Tab', { idempotent: true })
  },
  {
    name: 'stop_loading',
    description:
      "Stop a tab that is still loading, as the browser's stop button does. Use it on a page that never finishes (a hung request, a stuck iframe, a stream): while a tab is loading, Arc does not answer scripts, so a page tool called on it hangs until it times out. " +
      "Stopping unblocks them, and the page keeps whatever it had rendered. Reports whether the tab was loading, and fails if it still is afterwards.",
    input: z.object({ tab_id: TAB_ID.optional() }),
    annotations: write('Stop Loading', { idempotent: true })
  },
  {
    name: 'wait_for_load',
    description:
      'Poll until a tab has finished loading and the document is ready. Use after an action that triggers navigation. ' +
      "Checks Arc's own loading flag as well as document.readyState. Arc does not answer scripts while a tab loads, so the flag is what lets a slow server or a hung iframe show up as ready 'loading' on the timeout, instead of as a stalled call. If the load never ends, stop_loading ends it.",
    input: z.object({
      tab_id: TAB_ID.optional(),
      timeout_ms: timeoutMs(LOAD_TIMEOUT_MS, 'Give up after this long.'),
      url_contains: z.string().describe('Also wait until the url contains this substring').optional()
    }),
    annotations: read('Wait For Load')
  }
];

// A single osascript call must not outlive the wait it belongs to, or one
// wedged call started near the deadline stretches the whole tool past the
// client's timeout. Keep a floor so the last poll is still able to answer.
const MIN_PROBE_MS = 1500;
const probeBudget = (started, timeout) => Math.max(timeout - (Date.now() - started), MIN_PROBE_MS);

// Arc does not answer `execute javascript` for a tab that is still loading:
// the call hangs until the whole osascript timeout, whatever the page is doing,
// and an iframe that never finishes counts as loading (found against a
// localhost server that held a response open). The tab's own `loading` property
// answers instantly, so it is read first and the page is only asked once it is
// false. Verified in Arc 1.165 on file:// pages and on a slow http response.
// Not a verdict on its own: a tab with nothing to load reports false while
// readyState may still be "interactive", so the page is still asked after.
async function readyState(args, remainingMs) {
  const out = await runJxa(
    `const tab = target();
     const loading = tab.loading();
     JSON.stringify({ loading: loading, tab: describe(tab), result: loading ? null : evalJs(tab, P.page_code) });`,
    scoped({
      ...args,
      // timeOrigin identifies the document instance, which is how reload_tab
      // tells a fresh page from the one it asked Arc to replace.
      page_code: pageScript(`return { ready: document.readyState, url: location.href, origin: performance.timeOrigin };`)
    }),
    remainingMs
  );
  if (out.loading) return { loading: true, ready: 'loading', url: out.tab.url, origin: null, tab: out.tab };
  const { result, tab } = unwrapPage(out);
  return { ...result, loading: false, tab };
}

/**
 * The one polling loop behind every "has the tab actually moved" question.
 * `settled` vetoes readings until the navigation is real, and `requireReady` is
 * off for callers that only care that the move happened, not that it finished.
 */
async function waitForLoad(args, { settled, requireReady = true, extra } = {}) {
  const timeout = loadTimeout(args);
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    throwIfCancelled(extra);
    last = await readyState(args, probeBudget(started, timeout));
    // A loading reading has no document to judge yet: it can neither satisfy
    // `settled` (origin is null) nor be called ready.
    if (last.loading) {
      await sleep(POLL_MS);
      continue;
    }
    const urlOk = !args.url_contains || (last.url || '').includes(args.url_contains);
    const isReady = !requireReady || last.ready === 'complete';
    if (isReady && urlOk && (!settled || settled(last))) {
      return { ok: true, ready: last.ready, url: last.url, tab: last.tab, waitedMs: Date.now() - started };
    }
    await sleep(POLL_MS);
  }
  return {
    ok: false,
    timedOut: true,
    ready: last?.ready ?? null,
    url: last?.url ?? null,
    tab: last?.tab ?? null,
    waitedMs: Date.now() - started,
    note: last?.loading
      ? `Still loading after ${timeout}ms (Arc reports the tab as loading). A slow server or an iframe that never finishes looks like this: stop_loading ends the load and keeps what rendered.`
      : `Still not ready after ${timeout}ms. The page may be slow, or blocked on a login or dialog.`
  };
}

/**
 * Optional wait for the new document, shared by all four navigating tools. A
 * load timeout does not undo the navigation, so ok stays as the caller set it
 * and the note is what warns that the content may only be half there.
 */
async function withLoad(args, result, extra) {
  if (!result.tab || args.wait_until_loaded === false) return result;

  const timeout = loadTimeout(args);
  const loaded = await waitForLoad({ tab_id: result.tab.id, timeout_ms: timeout }, { extra });
  const out = { ...result, loaded: loaded.ok, ready: loaded.ready, tab: loaded.tab ?? result.tab };
  // A redirect can move the tab on again after the first url change, so keep
  // the reported destination in step with the final snapshot.
  if (result.to !== undefined && out.tab) out.to = out.tab.url;
  if (!loaded.ok) {
    out.note = `The tab did not finish loading within ${timeout}ms (readyState ${loaded.ready ?? 'unknown'}), so its content may be incomplete. Call wait_for_load to keep waiting, or read the page again afterwards.`;
  }
  return out;
}

// Arc's own goBack does nothing on a background tab, while goForward and reload
// do work. Both directions go through the page instead, where history.back()
// moves a background tab instantly.
const historyStep = (direction) => {
  const action = `went ${direction}`;
  return async (args, extra) => {
    const { result, tab } = await runPage(
      args,
      `var from = location.href;
       if (history.length < 2) return { error: 'no_history', from: from, historyLength: history.length };
       // Asynchronous: hand back the pre-move url and let Node confirm the move.
       history.${direction}();
       return { from: from, historyLength: history.length };`
    );

    const { from, historyLength } = result;
    if (result.error === 'no_history') {
      return {
        ok: false,
        action,
        from,
        historyLength,
        note: `history.length is ${historyLength}, so this tab has nothing to go ${direction} to.`,
        tab
      };
    }

    const moved = await waitForLoad(
      { tab_id: tab.id, timeout_ms: moveTimeout(args) },
      { requireReady: false, settled: (reading) => reading.url !== from, extra }
    );
    if (!moved.ok) {
      return {
        ok: false,
        action,
        from,
        historyLength,
        note: `The tab is still at ${from} ${moved.waitedMs}ms later, so nothing moved. Most likely there is no ${direction} entry in this tab's history (history.length is ${historyLength}, which counts both directions). A trapped navigation, a page still in flight, or a ${direction} entry with the same url would look the same from here.`,
        tab: moved.tab ?? tab
      };
    }

    return withLoad(args, { ok: true, action, from, to: moved.url, historyLength, tab: moved.tab }, extra);
  };
};

export const handlers = {
  open_url: async (args, extra) => {
    parseUrl(args.url);

    const result = await runTab(
      args,
      `if (!Arc.running()) { Arc.launch(); delay(1.5); }
       if (P.activate) Arc.activate();

       if (P.little_arc) {
         Arc.tabs.push(Arc.Tab({ url: P.url }));
         JSON.stringify({ ok: true, action: "opened in Little Arc", url: P.url, tab: null });
       } else if (P.new_tab === false) {
         const tab = target();
         tab.url = P.url;
         delay(0.4);
         JSON.stringify({ ok: true, action: "navigated existing tab", tab: describe(tab) });
       } else {
         requireArc();
         const named = P.space ? findSpace(P.space) : null;
         if (P.space && !named) throw new Error("SPACE_NOT_FOUND:" + P.space);
         const space = named || agentSpace();
         const container = space || mainWindow();
         const openedIn = space ? space.title() : "main window";

         let restoreId = null;
         if (!P.activate) { try { restoreId = mainWindow().activeTab.id(); } catch (e) {} }

         const tab = Arc.Tab({ url: P.url });
         container.tabs.push(tab);
         delay(0.6);
         const info = describe(tab);

         // Undo only Arc's own auto-select; if the user moved elsewhere meanwhile, leave them there.
         let restored = false;
         let stoleFocus = false;
         try { stoleFocus = mainWindow().activeTab.id() === info.id; } catch (e) {}
         if (stoleFocus && restoreId && restoreId !== info.id) {
           const previous = locate(restoreId);
           if (previous) { Arc.select(previous); delay(0.3); restored = true; }
         }
         JSON.stringify({ ok: true, action: "opened new tab", openedIn: openedIn, tab: info, restoredUserTab: restored });
       }`,
      OPEN_TIMEOUT_MS
    );

    // Only a tab this call created becomes ours. Navigating a tab the caller
    // named must not claim it, or close_own_tabs would later close the user's tab.
    if (result.tab && result.action === 'opened new tab') {
      state.claim(result.tab.id);
      result.tab.mine = true;
    } else if (result.tab) {
      result.tab.mine = state.isOwned(result.tab.id);
    }

    return withLoad(args, result, extra);
  },

  go_back: historyStep('back'),
  go_forward: historyStep('forward'),

  reload_tab: async (args, extra) => {
    // Arc.reload is the one Arc history command verified to work on a
    // background tab, and an in-page location.reload() would tear the document
    // down before the envelope could get back out.
    const { result, tab } = await runPage(args, `return { from: location.href, origin: performance.timeOrigin };`);
    const { from, origin } = result;

    await runTab({ ...args, tab_id: tab.id }, `Arc.reload(target()); JSON.stringify({ ok: true });`);

    // A reload always builds a new document and every document gets its own
    // timeOrigin. The navigation entry type stays "reload" for that document's
    // whole life, so it cannot tell this reload from an earlier one.
    const moved = await waitForLoad(
      { tab_id: tab.id, timeout_ms: moveTimeout(args) },
      { requireReady: false, settled: (reading) => reading.origin !== origin, extra }
    );
    if (!moved.ok) {
      return {
        ok: false,
        action: 'reloaded',
        from,
        note: `Arc accepted the reload, but ${moved.waitedMs}ms on the tab is still showing the document that was there before it. A slow server may not have responded yet, or the page may be holding on to unload.`,
        tab: moved.tab ?? tab
      };
    }

    return withLoad(args, { ok: true, action: 'reloaded', from, to: moved.url, tab: moved.tab }, extra);
  },

  stop_loading: async (args) => {
    const out = await runTab(
      args,
      `const tab = target();
       const wasLoading = tab.loading();
       Arc.stop(tab);
       delay(0.5);
       JSON.stringify({ wasLoading: wasLoading, loading: tab.loading(), tab: describe(tab) });`
    );
    const { wasLoading, loading, tab } = out;
    if (loading) {
      return {
        ok: false,
        wasLoading,
        loading,
        error: 'Arc accepted the stop, but the tab still reports loading half a second later. Call stop_loading again, or close the tab.',
        tab
      };
    }
    return {
      ok: true,
      wasLoading,
      loading,
      ...(wasLoading ? {} : { note: 'The tab was not loading, so there was nothing to stop.' }),
      tab
    };
  },

  wait_for_load: (args, extra) => waitForLoad(args, { extra })
};
