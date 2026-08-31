# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.0]: https://github.com/DB-25/arc-control-mcp/releases/tag/v0.3.0
[0.1.0]: https://github.com/DB-25/arc-control-mcp/releases/tag/v0.1.0
