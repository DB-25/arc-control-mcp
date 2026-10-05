import { agentWindow } from '../agent-window.js';
import { UserActiveError, userActiveResult } from '../user-activity.js';
import { runTab } from './shared.js';

// Exported so a test can parse-check it.
export const OPEN_TAB_SCRIPT = `requireArc();
const win = agentWindow();
if (!win) throw new Error("AGENT_WINDOW_MISSING");
const named = P.space ? spaceIn(win, P.space) : null;
if (P.space && !named) throw new Error("SPACE_NOT_FOUND:" + P.space);
const container = named || win;

const tab = Arc.Tab({ url: P.url });
container.tabs.push(tab);
delay(0.6);
const info = describe(tab);
// Only an explicit request leaves the new tab selected and Arc in front.
if (P.activate) { Arc.select(tab); Arc.activate(); delay(0.3); }
JSON.stringify({ ok: true, action: "opened new tab", openedIn: named ? named.title() : "agent window", tab: info });`;

/**
 * A new tab inside the one agent window, which is found or created first.
 * Creating a tab or a window can raise the window and take keyboard focus from
 * whatever the user is typing in, so the whole thing runs under withWindow:
 * it waits for the user to pause and puts their window back afterwards.
 *
 * The tab is pushed into the agent window itself rather than into a space,
 * because a tab pushed into a space is not tied to any window. A space named in
 * `space` is looked up in the agent window for the same reason. Unlike the
 * space mode, nothing here ever reads or reselects the user's active tab, so
 * there is nothing of theirs to put back.
 */
export async function openInAgentWindow(args, timeoutMs) {
  try {
    const done = await agentWindow.withWindow(
      () =>
        runTab(
          args,
          OPEN_TAB_SCRIPT,
          timeoutMs
        ),
      { restoreFocus: !args.activate }
    );

    const { window } = done;
    return {
      ...done.value,
      agentWindow: {
        id: window.id,
        created: window.created,
        placement: window.placement,
        ...(window.placementNote ? { note: window.placementNote } : {})
      },
      focusRestored: done.focusRestored,
      waitedForUserMs: done.waitedForUserMs,
      ...(done.focusRestoreError ? { focusRestoreError: done.focusRestoreError } : {}),
      ...(done.accessibilityNote ? { accessibilityNote: done.accessibilityNote } : {})
    };
  } catch (error) {
    if (error instanceof UserActiveError) return userActiveResult(error.gate);
    throw error;
  }
}
