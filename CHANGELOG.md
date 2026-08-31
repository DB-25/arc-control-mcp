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
  on Node 20 and 22 plus a syntax check over every file in `src/`.

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
