# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-05

This release makes the server a better guest and a more capable driver. Agent
tabs now live in one dedicated window and anything visible waits for you to stop
typing, so you can keep working while an agent browses. Pages can be read as a
tree with stable refs instead of guessed selectors, an optional DevTools engine
adds real input, screenshots and console and network capture, four tools read
Arc's own data files, and the operator can fence the agent in with guardrails.
The 0.3.0 rule still holds throughout: a call that did not do the thing says so.

### Added

#### Agent window and activity gate

- A dedicated agent window. `open_url` opens new tabs in one separate Arc window
  instead of the user's own. `ARC_MCP_WINDOW=dedicated` is the default; `space`
  keeps the old behaviour.
- At most one agent window, ever. Its id is stored in the shared state directory
  and found or created under a cross-process lock, and a new one is made only
  when the stored window is truly gone: a minimized window, or one Arc reports as
  `visible: false`, counts as present. A lock is broken only when its file is
  older than a stale threshold, never because a waiter ran out of patience, and
  the wait for the user to go idle happens before the lock is taken. Tested with
  concurrent callers against a fake Arc.
- `ARC_MCP_WINDOW_PLACEMENT` (`auto`, `second-display`, `minimized`, `none`).
  `auto` uses the largest non-main display and otherwise leaves the window where
  Arc puts it. `minimized` is experimental and not a default.
- Focus protection. With Accessibility, the server records which Arc window had
  focus and which application was in front before a window or tab is created, and
  puts both back, reporting `focusRestored`. That is true only when everything
  that was displaced is back and the front application was read again to confirm
  it; `focusRestoreError` says what was not. This also covers a cold start: with
  Arc not running there is no `Arc` process for Accessibility to ask about, which
  counts as unavailable for now (not a refusal, and not cached), so Arc is
  launched, the window made, and the front application put back. Without Accessibility there is no placement and
  no window restore, and a one-time `accessibilityNote` says how to grant it
  (errors -1719 and -25211 are mapped to it).
- The user-activity gate. Before anything that can change what is on screen or
  which window has focus (`open_url` with a new tab, `little_arc` or `activate`,
  `switch_to_tab`, `focus_space`, `screenshot` with `activate`, creating or moving
  the agent window, and the focus restore), the server waits until the user has
  been idle for `ARC_MCP_IDLE_MS` (1500 ms), polling for up to
  `ARC_MCP_IDLE_WAIT_MS` (15 s). If the user never pauses the tool fails with
  `ok: false, userActive: true`; otherwise it reports `waitedForUserMs`. Reads,
  page scripting and history are never gated. `ARC_MCP_IDLE_MS=0` disables it.
  Idle time comes from `ioreg -c IOHIDSystem` and needs no permission. If the
  user became active after this call had already created the window, the result
  carries `agentWindow: { created: true, id }` and says so instead of claiming
  nothing was touched.
- `arc_status` reports the agent window (id, placement, display, minimized),
  whether Accessibility is available, and the current user idle time.
  `list_tabs` rows carry `inAgentWindow`.

#### Snapshot and refs

- `snapshot`: the page as a compact indented tree of roles, accessible names and
  refs (`- button "Save" [ref=e12] (disabled)`). Walks open shadow roots and
  same-origin iframes, skips hidden subtrees, and takes `interactive_only`,
  `scope`, `depth`, `max_chars` (truncation is always reported), `boxes` and
  `diff`.
- Refs are stable across snapshots, and every selector argument accepts
  `ref=e12`, the DevTools tools included. A ref whose element was replaced by an
  identical one is re-resolved by role, name and position and reported as
  `reResolved: true`; one whose element is gone fails saying it is stale and to
  snapshot again.
- Selector forms `role=button[name="Save"]` (`name~=` for a substring),
  `label=Email` and `placeholder=Search`, in every tool that takes a selector.

#### CDP engine

For the three things Apple Events cannot do: real (trusted) input, screenshots,
and console and network visibility. It talks to Arc over the Chrome DevTools
Protocol using Node's built-in `WebSocket` (Node 22 or newer for these tools
only; `engines` is unchanged and everything else runs on 20). No new
dependencies.

- **It is on by default and inert until Arc exposes the port.** The first CDP
  tool probes `127.0.0.1:9222` (`ARC_MCP_CDP_PORT` changes the port,
  `ARC_MCP_CDP=0` disables the engine). A failed probe is cached for 10 seconds,
  so ordinary calls never pay for it. With nothing listening, every CDP tool
  returns `ok: false` plus the setup steps, and every other tool behaves as
  before. **Arc serves the port only when launched with
  `--remote-debugging-port`, and that port is unauthenticated: any local process
  can drive Arc through it.** Read `scripts/arc-cdp-setup.md` first.
- A tab is mapped to its CDP target by a one-time random marker that the Apple
  Event side writes into the page's DOM, never by URL or title. A target is used
  only after the marker is found in it, so another Chromium on the same port is
  never driven by mistake. Only targets at the tab's own address are probed, with
  one retry after a short wait, and a target on an origin the guardrails forbid is
  never probed. The mapping is cached and revalidated on every use. CDP never
  creates targets (`Target.createTarget` crashes Arc).
- New tools: `cdp_status`, `screenshot` (viewport, `full_page`, or an element;
  PNG or JPEG; returns MCP image content; works on a background tab),
  `trusted_click` (`button`, `click_count`), `trusted_type` (`per_key`, `clear`),
  `trusted_press_key` (modifiers such as `Meta+A`), `trusted_hover`, `drag`
  (including native HTML5 drag and drop), `upload_file`, `handle_dialog`,
  `console_messages` and `network_requests`.
- `trusted_type` fails with `ok: false` and types nothing when the field it was
  asked to fill never took focus, rather than typing into whatever had it.
- `ref=`, `role=`, `label=` and `placeholder=` selectors work in `trusted_*`,
  `drag`, `upload_file` and `screenshot`. The ref table lives in Arc's isolated
  world, which CDP cannot see, so the selector is resolved on the Apple Event side
  and the element is stamped with a one-time `data-arc-mcp-target` attribute that
  the DevTools call selects and then removes. Stale-ref failures and
  `reResolved` behave as in `click`.
- A JavaScript dialog opened by an action is reported in that tool's result
  instead of hanging it, and other CDP tools say a dialog is open and point at
  `handle_dialog`.
- `console_messages` and `network_requests` record from the first time a CDP tool
  touches a tab (CDP has no history). Bodies are never stored. `network_requests`
  shows urls without their query string and fragment unless `include_query` is
  set, and headers are opt-in.
- `arc-control-mcp --check-cdp` probes the port and prints the browser and page
  count (`npm run check-cdp` does the same). It changes nothing and exits 1 when
  nothing answers.
- `scripts/arc-cdp-setup.md`, `scripts/arc-cdp-healer.sh` and a LaunchAgent
  template. The healer re-applies the flag after a Sparkle update: every 30
  seconds, and only when Arc is running, the port is closed and Arc started less
  than 90 seconds ago does it quit Arc gracefully and reopen it with the flag. It
  waits 10 minutes between attempts, never force-kills, and is not installed by
  anything in this package.
- A tool result can now carry an image. `batch` drops it and says so.

#### Local data

- Four read-only tools that read Arc's own data files instead of driving Arc,
  for state Apple Events cannot report and in milliseconds:
  - `sidebar_tree`: spaces with pinned items (folders nested), unpinned tabs and
    top apps, each tab with title, url, last-active time and its `tab_id`.
    `match_live` marks which tabs are open.
  - `find_stale_tabs`: tabs idle for N days, oldest first, with space and
    pinned / unpinned / top app, plus exact duplicate URLs.
  - `search_archive`: search archived and closed tabs by text, newest first.
  - `search_history`: search browsing history by text and time window. Opt-in:
    it returns `ok: false` unless `ARC_MCP_ALLOW_HISTORY=1` is set.
- `ARC_MCP_ARC_DATA_DIR` relocates the directory these tools read.
- Every local data result reports `asOf` (the file's modification time) and a
  note that Arc writes these files periodically. A missing file, invalid JSON, an
  unknown format version or an unexpected history schema fails with `ok: false`.
  History is read from a temporary copy that is deleted afterwards, through the
  macOS `sqlite3`, with no new dependency. Nothing is ever written to Arc's files.

#### Guardrails

Read once from the environment at startup, so an agent cannot loosen them.

- `ARC_MCP_ALLOWED_ORIGINS` and `ARC_MCP_BLOCKED_ORIGINS` (comma lists,
  `*.example.com` wildcards) limit which origins the agent may touch: `open_url`
  is checked against its target, every other changing tool against the target
  tab's current URL. That includes the CDP page-changing tools (`trusted_click`,
  `trusted_type`, `trusted_press_key`, `trusted_hover`, `drag`, `upload_file`,
  `handle_dialog`). A refused call returns `ok: false`, `blocked: true` and the
  rule that did it. A navigation that a redirect lands on a blocked origin is
  reported as a failure.
- `ARC_MCP_BLOCK_READS=1` applies the rules to read tools too, the CDP reads
  included. `ARC_MCP_READ_ONLY=1` advertises and runs only the read tools.
- `ARC_MCP_AUDIT_LOG=<path>` appends one JSON line per changing call (time, tool,
  tab, origin, ok, error) and never logs typed values, fill values or script
  code. `arc_status` reports the guardrails in force.

#### Interaction and capture tools

- `click`, `fill`, `select_option` and `press_key` wait for the DOM to go quiet
  and report `settledMs`, `settled` and `mutations`. `settle_ms` sets the quiet
  window (default 300, `0` skips, capped at 1500).
- `wait_for_text`: poll until any of several strings, or a regex, appears in or
  disappears from the page's text or a scope selector.
- `fill_form`: fill up to 50 fields in one page call, each through the same
  checks as `fill`, with a result per field and `ok: false` naming any that failed.
- `hover`: pointerover, pointerenter, mouseover, mouseenter, pointermove and
  mousemove at the element's center, with `coveredBy` like `click`.
- `type`: character-by-character typing (keydown, keypress, beforeinput,
  native-setter append, input, keyup) for widgets that ignore `fill`, with an
  optional `delay_ms`. It verifies the final value and fails when characters
  did not go in.
- `stop_loading`: Arc's AppleScript `stop` on a tab.
- `capture_start`, `capture_read`: record console output, errors, unhandled
  rejections and fetch and XMLHttpRequest calls (never bodies or headers).
  Arc runs scripts in an isolated world that cannot see the page's `fetch` or
  `console`, so the recorder is injected as a `<script>` element and relays
  events through the DOM. A page whose CSP blocks that gets `ok: false` and the
  reason, never a capture that silently records nothing.
- `network_entries`: the page's requests from resource timing, with no recorder.

### Changed

- `screenshot`, `console_messages` and `network_requests` resolve a call with no
  `tab_id` like a changing tool: a tab this agent opened, or a refusal, never the
  tab the user is looking at. They attach a debugger, so reading is not as
  harmless as it is for the other read tools. `arc_status` lists them under
  `resolvesTo.readsThatResolveAsMutating`.
- `network_requests` urls no longer include the query string by default, as in
  `capture_read`. Pass `include_query` to keep it. `url_contains` matches the url
  as shown.
- `wait_for_load` reads the tab's `loading` property before asking the page.
  Arc does not answer `execute javascript` on a tab that is loading, so the old
  probe could sit for its whole timeout; a loading tab now reports
  `ready: "loading"` and the timeout note points at `stop_loading`.
- `isActive` is never set on a tab of the agent window, so a read-only tool with
  no `tab_id` cannot fall back to an agent tab as if it were the user's.
- A tab this agent opened is looked up through the agent window first, so
  selecting or closing it never goes through the user's window.
- `arc_status` and every read tool never launch Arc.

### Fixed

- Tabs are addressed by id rather than by position. A positional specifier is
  re-resolved on every Apple Event, so another process opening or closing a tab
  between a lookup and the action that followed it could land the action on a
  different tab (seen as `stop_loading` describing another agent's tab).

### Security notes

- The DevTools port is unauthenticated: any process running as you can drive Arc
  through it once Arc is launched with `--remote-debugging-port`. The engine is
  inert until then, `ARC_MCP_CDP=0` switches it off, and `cdp_status` repeats the
  warning.
- `upload_file` refuses relative paths, missing files, directories, and
  credential, shell-history, mail and browser-profile files (`~/.ssh`, `~/.aws`,
  `.env` and `.env.*`, `.zsh_history`, `.bash_history`, Arc and Chrome profiles,
  `~/Library/Messages`, `Mail`, `Safari` and `Keychains`), including through a
  symlink and whatever the letter case.
- Header values are redacted as they arrive: `cookie`, `authorization`,
  `set-cookie`, and any name starting `x-auth` or containing `token`, `secret`,
  `key`, `session` or `signature`. Bodies are never stored.
- The audit log withholds the reason for a failed `press_key`,
  `trusted_press_key` or `handle_dialog`, and scrubs `key` and `prompt_text`
  values, since a key sequence can be a typed password.
- Mapping a tab to its DevTools target no longer attaches to every page on the
  port and evaluates in it, which would have run a script in tabs unrelated to the
  call, on origins the guardrails forbid.

### Known limits

- Without Accessibility a minimized agent window cannot be told from a closed
  one, so a closed window is not recreated until Accessibility is granted or the
  `agent-window.json` file in the state directory is deleted.
- `ARC_MCP_WINDOW_PLACEMENT=minimized` has not been verified live.
- The first input event sent to a background tab stalls for about five seconds
  unless focus emulation is on. The trusted tools turn on
  `Emulation.setFocusEmulationEnabled` once per attached tab, after which input
  and screenshots on a background tab are immediate and do not bring it forward.
- A synthetic or CDP `Meta+A` does not select all on macOS by itself, because the
  menu bar handles it. `trusted_press_key` sends the matching editing command
  with `Meta` shortcuts (`A`, `C`, `V`, `X`, `Z`).

## [0.3.1] - 2026-10-05

The 0.3.0 theme continued: three more ways a call could report success for
something no user could have done, each found by driving real pages.

### Fixed

- `click` reported success on a disabled control. A `text=` match usually lands
  on a label span inside a button, and the span's own `disabled` was always
  false, so a click the page swallowed came back as `ok: true`. `click` now
  checks the nearest control (button, link, input, label, ARIA roles), fails
  with `ok: false` when it is disabled or inside `aria-disabled="true"`, and
  returns that control as `control`. Found on GitHub's "Save pins" button.
- `query_elements` and every other `describe` result report `disabled` for
  the nearest control, so a label inside a disabled button reads as disabled.
- `text=` matching ranked a hidden element ahead of a visible one when it came
  first in the DOM, so `click` could hit a button in a collapsed menu while the
  visible twin never fired. Visible matches now rank ahead of hidden ones within
  the exact and substring groups.
- `select_option` set a disabled `<select>`, or a disabled option, which no user
  can do. Both now fail with `ok: false` and leave the value alone.

- `open_url` with `new_tab: false` and a named `tab_id` claimed that tab as the
  agent's own. If it was the user's tab, a later `close_own_tabs` closed it.
  Only a tab the call creates is claimed now.
- `batch` treated a read tool's failure (`{ error }` with no `ok` field) as a
  success and ran on, and returned `ok: true` for a batch that stopped early.
  Both now fail the batch.
- `fill` with `submit: true` always said `submitted: true`. It now watches for a
  real submit event, skips `requestSubmit` when the page's own Enter handler
  already submitted (which used to send the form twice), lists the invalid
  fields when the form fails validation, and fails when nothing was submitted.
- `fill` set `.value` on a checkbox, radio or button and reported success, and
  missed a field disabled by its `<fieldset>`. It refuses both now, and fails
  when the field rejects the value (a number input given text).
- `press_key` accepted any key name as a silent no-op and sent `Space` as the
  literal key "Space". Unknown names now fail, `Space` sends " ", and the
  result reports `defaultPrevented`. The description now says plainly that a
  synthetic key types nothing and submits nothing.
- `click` scrolls with `behavior: "instant"`, so a page with smooth scrolling no
  longer gets the click aimed at where the element was mid-animation.

### Added

- `click` checks what a real pointer would hit at the target's center before
  clicking. When an overlay, a modal backdrop or `pointer-events: none` would
  stop a user, the click still goes through but the result carries `coveredBy`
  and a `warning`.

### Documented

- Background tabs never bring anything on screen, so pages that load code
  through `IntersectionObserver` or `loading="lazy"` may never run it there. The
  disabled-click error says when the tab is hidden, and the README covers it.

## [0.3.0] - 2026-08-31

This release is mostly about one class of bug: the server used to report success
for things that had not happened. If you have been running 0.1.x, assume any
`ok: true` you saw from a page-touching tool was unverified. The findings came
from an agent review of the running server, kept at
[docs/agent-review-2026-08-31.md](docs/agent-review-2026-08-31.md).

The second thread is protocol conformance. The tools themselves worked. How
results, failures, timeouts and cancellations were reported over MCP did not
match what a client, or a model reading the response, has any right to expect.

### Changed: a tool that changes a tab will not touch the tab you are looking at

A call with no `tab_id` used to resolve to this agent's own tab and then, failing
that, to whatever tab was active in Arc. That second fallback applied to every
tool, so an agent that called `go_back` or `reload_tab` without a `tab_id`
navigated and reloaded a tab a human was reading. That happened.

Resolution is now split by whether the tool changes anything:

- An explicit `tab_id` always wins.
- Otherwise, a tab this agent opened.
- Otherwise, for a **read-only** tool, the tab you are looking at. Reading the
  page you already have open is useful and harmless.
- Otherwise the call is **refused**, with an error naming what to pass instead.

`tab_id` was deliberately not made mandatory everywhere. That would force a
`list_tabs` round trip before every call, and each `osascript` spawn costs a few
hundred milliseconds. It would also break the implicit targeting that lets
`open_url`, then `click`, then `fill` run without ids.

`arc_status` now reports both branches, as `resolvesTo.readOnly` and
`resolvesTo.mutating`, since one string can no longer describe both.

Also fixed in the same area: a state file written by the pre-0.3.0 flat format is
no longer treated as a finished run whose tabs can be reaped. It carries no
session identity, so it may equally belong to a server still running the old
code, and treating it as dead once marked two live user tabs for closing.

### Added: arguments are validated before a handler runs

Nothing validated tool arguments at all, so a wrong type surfaced as a confusing
error from inside the page. Every tool now declares its arguments as a Zod
schema, the JSON Schema advertised over MCP is generated from it, and the same
schema validates the call. A bad argument comes back as an `isError` result
naming it:

```
Invalid arguments for click. selector: Invalid input: expected string, received number
```

Because `batch` calls its peers through the registry, batch steps are validated
too. Declared defaults are now applied by the parser rather than by a fallback in
each handler. `zod` becomes a declared dependency: it was already present via the
MCP SDK, so it deduplicates to a single copy and adds nothing to an install.

The server stays on the SDK's low-level `Server` rather than moving to
`McpServer.registerTool`, which rejects generated JSON Schema and would mean
rewriting every schema again. It also does not declare `outputSchema` or return
`structuredContent`: the low-level `Server` does not validate them, so declaring
them would commit the project to a specification MUST with nothing enforcing it,
and `execute_javascript` and `batch` have genuinely unschematisable outputs.

### MCP protocol conformance

- **A tool that ran and failed now says so where the model can see it.** A
  failed `click` used to arrive as an ordinary successful MCP result whose text
  happened to contain `"ok": false` somewhere inside it. A model reads a
  successful result as "the call worked" and carries on building on something
  that never happened. Failures now set `isError` on the result, so a failed
  click is visible as a failure and the model can retry or pick a different
  selector.
- **An unknown tool name is now a JSON-RPC error.** It used to come back as a
  tool result carrying `isError`, which is the shape reserved for a tool that
  ran and failed. The spec lists an unknown tool under protocol errors, so it
  now raises `InvalidParams`, with the list of real tool names in the message.
- **A call can no longer outlive the client's deadline.** An MCP client gives up
  on a request after 60 seconds by default, and once it does, the server's
  answer is thrown away: you see `RequestTimeout` instead of the `timedOut`
  payload that says what the page was actually doing. `open_url`'s worst case
  was a 45s open budget plus a 15s load wait, exactly 60000 ms, so a slow page
  reliably produced a client timeout rather than the server's own honest "still
  loading" answer. A caller-supplied `timeout_ms` had no cap at all. The open
  budget is now 25s, every `timeout_ms` is clamped to 30s, and the ceiling is
  stated both as a schema `maximum` and in the description, together with what
  to do instead: call `wait_for_load` or `wait_for_selector` again. Repeated
  short waits each hand back a real `readyState`, `url` or element count, which
  one long wait does not.
- **Cancelling a call now stops it.** The polling loops behind
  `wait_for_load`, `wait_for_selector`, `open_url`, `go_back`, `go_forward`,
  `reload_tab` and `batch` check the client's cancellation signal between polls.
  Before, a cancelled call kept spawning `osascript` processes against your
  browser for a result nobody was going to read. A cancelled `batch` reports how
  many of its steps had already run, because whatever those steps did to the
  page stands.
- **`execute_javascript` and `batch` no longer claim `destructiveHint: false`.**
  That is not defensible for two tools that can do anything a page can do,
  including submitting a form or clicking a delete button. `openWorldHint` is
  now true for every tool that touches page content, and false only for the
  tools that read or move Arc's own tab and space bookkeeping.
- **`close_tab` now says that a bare call can close the tab you are looking
  at.** Its description was "Close a tab." A call with no `tab_id` resolves to
  this agent's current tab or, when it has none yet, whatever tab is active in
  Arc, which may well be yours. The description says so now, and points at
  `close_own_tabs` for cleanup.
- **`batch` has an aggregate response cap.** The individual read tools capped
  their own output, but nothing capped the total, so a batch of several reads
  could return a response large enough for a client to clip mid-JSON. There is
  now a 60000 character budget across all steps. Past it the batch stops early
  and reports `truncated`, with a note telling you to pass `max_chars` to the
  reading steps or split the sequence across two calls.
- **The server introduces itself at initialize.** It now sends MCP
  `instructions`, plus a display `title` and a `websiteUrl`. The instructions
  carry the facts a model otherwise wastes a call discovering: call `arc_status`
  first, background tabs are fully scriptable so prefer passing a `tab_id` over
  switching what the user is looking at, `text=` is substring matching, batch a
  known sequence, and page content is untrusted data rather than instructions.

### Fixed

- **A page script that threw was reported as success.** The JXA layer collapsed
  Arc's empty response into `null`, and every handler spread that `null` into a
  cheerful `{ok: true}`. In the worst observed case, a four-step `batch` in
  which nothing at all happened returned `ok: true` on every step and at the top
  level. Every injected script now returns an explicit envelope, so a failure
  comes back as a real error carrying the page's own message, for example
  `The page script failed: SyntaxError: ...`. An invalid selector and a missing
  element are now distinguishable.
- **`execute_javascript` silently returned `null` for any statement body.** Code
  without the literal word `return` was wrapped as `return (code)`, which is a
  syntax error for anything that is not a single expression. A thrown error, a
  syntax error and a legitimate null result were all indistinguishable. Code is
  now validated in Node before it is injected: the expression form is tried
  first, then the statement form, and if neither parses you get the actual
  `SyntaxError` message without Arc being contacted. The response reports which
  form was used, so a real null is no longer ambiguous.

  Note the limits of this. A statement body still yields a value only through
  `return`, because giving `let n = 2; n * 3` the completion value `6` would
  need `eval` inside the page, and that breaks on any site with a strict
  Content-Security-Policy. Instead of a bare `null` you now get an explanatory
  note telling you to add a `return`.
- **`go_back` was a silent no-op that reported success.** `Arc.goBack` does
  nothing on a background tab (reproduced on a tab with a real back entry,
  polled out to 4 seconds), and none of the history tools checked that the tab
  had moved. `go_back` and `go_forward` now go through the page's own history
  API and verify the URL changed before reporting success. The tab snapshot in
  the response is taken after the navigation, not 400ms into it.
- **Two agents sharing a label corrupted each other's tab ownership.** The
  in-process set of owned tabs was seeded from a shared state file, and whichever
  process wrote second dropped the other's tabs. That meant `close_own_tabs`
  from one agent could close another agent's tabs. Ownership is now tracked per
  session, and stale entries from previous runs are reaped deliberately at
  cleanup time rather than by accident on the next write.
- **`get_page_content` with a selector returned only the first match.** Asking
  for `#mw-content-text p` on a Wikipedia article with 19 paragraphs returned the
  lead paragraph and `truncated: false`, with nothing in the response hinting at
  the other 18. It now returns all matches and reports how many there were.
- **`fill` reported success on elements that cannot be filled.** Filling an
  `<h1>` returned `ok: true`. It now returns a descriptive error naming the tag.
- **`text=` did not prefer exact matches.** `text=Save` could click "Save and
  close" because matching is by substring and the first DOM-order hit won. Exact
  matches are now ranked ahead of substring matches.
- **1x1 screen-reader elements were reported as visible.** The visibility check
  only rejected elements whose width and height were both zero, so the standard
  clipped 1x1 accessibility span passed as a plausible click target. It is now
  rejected.
- **Non-serializable script results came back as a bare `{}`.** `return window`
  looked like an empty object with no explanation. The response now carries a
  note saying the value could not be serialized.

### Changed

- **Responses are smaller.** `batch` used to repeat the full tab object,
  including a 300-character URL, on every step; the tab is now emitted once per
  batch and repeated only when it changes mid-batch. Element descriptions no
  longer include `rect` and long attribute values by default, which are behind a
  new `verbose` option on the tools that describe elements.
- **`press_key` no longer returns page text.** It used to include several hundred
  characters of the body's `innerText` as its `target`.
- **Error messages distinguish an Arc or page problem from a bug in this
  server.** Anything that is not a mapped Arc error is now labelled as internal.
- **Selector documentation states that `text=` is substring matching**, in the
  tool schemas as well as the README, so an agent reading the schema knows.

### Added

- `execute_javascript` now reports the wrapper it chose as `form`
  (`"expression"` or `"statement"`), which is what makes a legitimate `null`
  result distinguishable from a script that failed.

- `list_spaces` reports `topAppCount`, so its per-space tab counts reconcile
  with `list_tabs`. Arc excludes topApp favourites from `space.tabs`, which made
  9 reported tabs against 21 real ones look like a bug.
- An `exact: true` option on the tools that take a selector, so a `text=`
  selector can require the whole text instead of a substring. They also report
  how many elements matched, so a label that hits 37 elements says so.
- `close_own_tabs` takes `include_stale`, and `arc_status` reports
  `staleTabCount`, so tabs leaked by a dead earlier run of the same label can be
  cleaned up on purpose instead of being swept up by a restart.
- `get_html` takes `nth` and reports how many elements matched, so a
  multi-match selector is visible there too.
- `ARC_MCP_STATE_DIR` to override where tab ownership is recorded.
- `--version` and `--help` on the server binary, so an install can be checked
  without an MCP client. `--help` prints the tool count and the environment
  variables.
- Documentation of a genuine limitation that is not a bug: synthetic events
  cannot drive widgets gated on trusted events. Wikipedia's search suggestions
  never open from `fill`, and hand-dispatched per-character
  `keydown`/`input`/`keyup` does not help, because Arc's
  `execute javascript` gives no CDP access. The workaround does work: `fill`
  with `submit: true`, or navigate straight to the search URL.
- Public project files: MIT license, contributing guide, security policy, code
  of conduct, issue and pull request templates, and CI that runs the unit tests
  on Node 20, 22 and 24 plus a syntax check over every file in `src/`.
- Distribution. This is the first version published to npm, as
  `arc-control-mcp`, and listed in the MCP Registry as
  `io.github.DB-25/arc-control-mcp`. Installing is now a config block running
  `npx -y arc-control-mcp@latest` in any MCP client, instead of a clone plus a
  hand-written absolute path, and upgrading is a restart rather than a `git
  pull`. The npm package declares `"os": ["darwin"]`, so a Linux or Windows
  install fails at once with `EBADPLATFORM` rather than succeeding and then
  failing at the first Apple Event. There is no Docker image and there cannot
  be one: Apple Events do not cross a container boundary.

## [0.1.0] - 2026-08-27

Initial version.

- MCP server over stdio that drives Arc on macOS through JXA
  (`osascript -l JavaScript`), with tool arguments injected as a JSON literal
  rather than concatenated into script source.
- 26 tools in six modules: tabs, navigation, content, interaction, spaces and
  scripting, composed by a registry that validates tool and handler parity at
  load.
- Implicit tab targeting, per-agent tab ownership with a `mine` flag on every
  tab, and `close_own_tabs` for cleanup.
- No focus stealing: `open_url` restores the user's previous tab selection when
  Arc auto-selects a new tab, and only when Arc actually took it.
- Selectors accept CSS or `text=Some label`.
- `batch` for running several tools in one round trip, which matters because
  each `osascript` spawn costs a few hundred milliseconds.
- Arc's raw AppleScript error codes mapped to messages that name the remedy,
  including both required macOS permissions.

[0.4.0]: https://github.com/DB-25/arc-control-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/DB-25/arc-control-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/DB-25/arc-control-mcp/releases/tag/v0.3.0
[0.1.0]: https://github.com/DB-25/arc-control-mcp/releases/tag/v0.1.0
