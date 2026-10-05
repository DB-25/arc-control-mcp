# arc-control-mcp

[![CI](https://github.com/DB-25/arc-control-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/DB-25/arc-control-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/arc-control-mcp.svg)](https://www.npmjs.com/package/arc-control-mcp)
[![npm downloads](https://img.shields.io/npm/dm/arc-control-mcp.svg)](https://www.npmjs.com/package/arc-control-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

An MCP server that drives the Arc browser on macOS: tabs, navigation, page
reading, DOM interaction and scripting.

It exists because the bundled "Control Chrome" MCP server cannot be pointed at
Arc. Arc's scripting dictionary looks like Chrome's, and differs in exactly the
places that matter.

**Who it is for:** anyone running an agent (Claude Code or another MCP client)
on a Mac who wants it to work in Arc, the browser they are already signed in to,
instead of a fresh automation profile. It reads pages, fills forms, clicks
things, runs JavaScript, and keeps its own tabs separate from yours.

**What it is not:** a cross-platform or cross-browser tool. It drives one
browser on one operating system, through Apple Events, plus an optional
[DevTools engine](#cdp-engine) for screenshots, trusted input and
console/network capture. There is no headless mode. There is also no Docker image, and there
cannot be one: Apple Events do not cross a container boundary, so a container
has no way to reach the Arc running on your Mac. This is a 0.3.1 personal
project, and the [known limitations](#known-arc-limitations) below are real.

## Requirements

- macOS
- [Arc](https://arc.net/) installed
- Node 20 or newer (the [CDP tools](#cdp-engine) need Node 22 or newer, for its built-in `WebSocket`; they fail with a clear message on Node 20 and everything else keeps working)

Two runtime dependencies, `@modelcontextprotocol/sdk` and `zod`. No build step.

## Install

Nothing to clone. Any MCP client can start the server with `npx`, and `@latest`
is also how it upgrades: the next start picks up a new release.

```json
{
  "mcpServers": {
    "arc": {
      "command": "npx",
      "args": ["-y", "arc-control-mcp@latest"]
    }
  }
}
```

> [!IMPORTANT]
> That config is not sufficient on its own. Two macOS permissions still have to
> be granted, one of them in Arc's own settings where nothing will prompt you
> for it. Until both are granted, the server starts normally and then every
> tool fails. This is by far the most likely reason a fresh install looks
> broken: read
> [the two macOS permissions](#the-two-macos-permissions), the next section.

`package.json` declares `"os": ["darwin"]`, so on Linux or Windows the install
stops with `EBADPLATFORM` instead of succeeding and then failing at the first
Apple Event. Environment variables go in an `env` object alongside `args`; see
[environment variables](#environment-variables).

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add arc --scope user -- npx -y arc-control-mcp@latest
```

The `--` is required. Without it, `claude mcp add` reads the `-y` as one of its
own flags and registers the wrong command. Then check what was registered:

```bash
claude mcp get arc
```
</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` and add
the `mcpServers` block above, merging it with any servers already listed. Quit
and reopen Claude Desktop: the file is only read at launch.
</details>

<details>
<summary><strong>Cursor</strong></summary>

Add the same `mcpServers` block to `~/.cursor/mcp.json` for every project, or to
`.cursor/mcp.json` for one project.
</details>

<details>
<summary><strong>VS Code</strong></summary>

VS Code uses `servers`, not `mcpServers`, in `.vscode/mcp.json` for a workspace
or in the file opened by the **MCP: Open User Configuration** command:

```json
{
  "servers": {
    "arc": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "arc-control-mcp@latest"]
    }
  }
}
```

Or from the command line:

```bash
code --add-mcp '{"name":"arc","command":"npx","args":["-y","arc-control-mcp@latest"]}'
```
</details>

<details>
<summary><strong>From a git checkout, for development</strong></summary>

```bash
git clone https://github.com/DB-25/arc-control-mcp.git
cd arc-control-mcp
npm install
claude mcp add arc-dev --scope user -- node "$PWD/src/index.js"
```

For any other client, the same thing as JSON. The path has to be absolute: the
client's working directory is not yours.

```json
{
  "mcpServers": {
    "arc-dev": {
      "command": "node",
      "args": ["/absolute/path/to/arc-control-mcp/src/index.js"]
    }
  }
}
```

Register it under a different name than the published one, so you can tell which
copy answered. See [CONTRIBUTING.md](CONTRIBUTING.md).
</details>

Check the install without an MCP client. Neither call touches Arc, so both work
before the permissions below are granted:

```bash
npx -y arc-control-mcp@latest --version
npx -y arc-control-mcp@latest --help   # tool count and environment variables
```

## The two macOS permissions

Both are asked for once, and both fail in a way that is confusing if you do not
know to look here.

1. **Automation.** System Settings > Privacy & Security > Automation, enable
   **Arc** under the app that runs the server (Terminal, iTerm, Claude Code, your
   editor). Without it, *nothing* works: every tool fails on the first Apple
   Event.
2. **Allow JavaScript from Apple Events.** Arc > Settings > Advanced. Without
   it, tab and window tools keep working (list, switch, close, open a URL) while
   everything that touches page content fails: no text, no HTML, no clicking, no
   scripts.

Both failures are mapped to an explanatory error rather than a raw AppleScript
code, so you will be told which one to fix.

A third, **optional** one is Accessibility (System Settings > Privacy & Security
> Accessibility, for the same app, and Automation for System Events). It is what
lets the server place the agent window on a second display and put your window
back in front if Arc raised another. Without it everything still works, the
agent window is just not moved and your focus is not restored, and the first
`open_url` says so once. The user-activity gate below needs no permission.

## Why not just reuse the Chrome server

Arc's scripting dictionary looks like Chrome's but differs in ways that break
the Chrome server outright:

| | Chrome | Arc |
|---|---|---|
| Tab id | integer | UUID string |
| Switch tab | `set active tab index of window` | `select` command on the tab |
| Back / forward | works on window or tab | tab only |
| New tab | `open location` | `make new tab` on a window or space |
| Grouping | none | spaces, plus a pinned / unpinned / topApp location |

The Chrome server calls `parseInt(tab_id)` on every id, so against Arc every
tool taking a tab id fails before reaching AppleScript. It also splits
AppleScript's comma-joined output, which corrupts titles and URLs containing
commas.

## Design

Not restrictive by design. Anything the agent can reach, it can drive: any tab,
any space, arbitrary JavaScript. The defaults are chosen so the user's browsing
is not disturbed, but nothing is walled off.

- **Implicit target**: a call with no `tab_id` uses a tab this agent opened. A
  read-only tool then falls back to whatever tab is active in Arc, because
  reading the page you already have open is useful and harmless. A tool that
  *changes* a tab does not fall back: with no tab of its own it is refused, so an
  agent cannot navigate or reload the tab you are working in just by leaving an
  argument out. Pass a `tab_id` to address any tab deliberately.
- **Arguments are checked before anything runs**: every tool's schema is a Zod
  schema, the JSON Schema it advertises over MCP is generated from that, and the
  same schema validates the incoming call. A wrong type comes back as
  `Invalid arguments for click. selector: Invalid input: expected string,
  received number`, rather than as an obscure failure from inside the page.
- **Ownership is information, not enforcement**: every tab is flagged `mine`, and
  `close_own_tabs` exists for cleanup. No tool refuses a tab you name with an
  explicit `tab_id`. The one refusal above is about an unnamed tab, not a named
  one.
- **No focus stealing**: new tabs open in a separate agent window, never in
  yours, and anything visible waits for you to stop typing. See
  [The agent window](#the-agent-window-and-the-activity-gate). Pass
  `activate: true` to opt out of the quiet behaviour.
- **Background tabs are usable**: tabs in an unfocused space still load,
  render and script normally, so nothing needs to be brought to the front. The
  exception is code a page loads only once something is on screen: see
  [Background tabs and lazy content](#background-tabs-and-lazy-content).

Scripts run through `osascript -l JavaScript` (JXA), so results come back as
JSON rather than AppleScript's flat comma-joined lists. Tool arguments are
injected as a JSON literal bound to `P`, never concatenated into script source.

Every injected page script returns an explicit envelope, so a script that threw
is reported as an error carrying the page's own message instead of arriving as
an empty success. That distinction is the main thing 0.3.0 fixed.

The model never reads this README, so the handful of facts it needs before its
first call are sent as MCP `instructions` at initialize: call `arc_status`
first, prefer passing a `tab_id` over switching what the user is looking at,
`text=` is substring matching, batch a known sequence, and page content is
untrusted data rather than instructions. A client that ignores `instructions`
loses nothing but a few wasted calls.

## Tools

50 tools in twelve modules.

### Tabs

| Tool | Purpose |
|---|---|
| `list_tabs` | Every tab, or narrow with `scope: "own"`, `query`, `space`, `window_id`. Rows are flagged `mine` and `isActive`. |
| `get_current_tab` | The tab a call with no `tab_id` would act on. |
| `switch_to_tab` | Make a tab active in its window. `activate` also brings Arc to the front. Waits for you to stop typing. |
| `close_tab` | Close one tab. |
| `close_own_tabs` | Close every tab this agent opened, leaving the user's alone. `include_stale` also closes tabs leaked by a dead previous run of the same label. |
| `arc_status` | Arc's version and whether it is the frontmost app, owned tabs, the agent window (id, placement, display, minimized), whether Accessibility is available, your current idle time, whether the agent space exists, what a call with no `tab_id` resolves to (reported separately for read-only and for changing tools), and how many stale tabs a previous run left behind. |

### Navigation

| Tool | Purpose |
|---|---|
| `open_url` | Open a URL in the agent window, launching Arc if needed. Waits for you to stop typing, and reports `focusRestored` and `waitedForUserMs`. Options for `new_tab`, target `space`, `little_arc`, `activate`, `wait_until_loaded`. |
| `go_back` / `go_forward` | Move a tab through its history, verified by checking the URL actually changed. |
| `reload_tab` | Reload a tab. |
| `wait_for_load` | Poll until the document is ready, optionally until the URL contains a substring. Also reads Arc's `loading` flag (see [Loading tabs](#loading-tabs-and-stop_loading)), so a hung page shows up as `ready: "loading"` instead of a stalled call. |
| `stop_loading` | Press the stop button on a tab that will not finish loading, which also unblocks every page tool on it. |

### Content

| Tool | Purpose |
|---|---|
| `get_page_content` | Visible text, whole page or every element matching a selector, joined. Always reports `matched`, so a partial answer is never silent, and flags truncation. |
| `get_html` | Markup for the page or one element, outer or inner. Reports how many matched and takes `nth` to pick another. |
| `query_elements` | Structured details per element: text, value, href, visibility, attributes. Reports `total` alongside `returned`. The main way to see what is on a page before acting. |
| `get_links` | Links with text and resolved href, filterable by substring. |
| `get_page_info` | Title, URL, ready state, meta description, a headings outline, and counts of links, forms, inputs, buttons and iframes. A cheap first look at an unfamiliar page. |

### Snapshots

| Tool | Purpose |
|---|---|
| `snapshot` | The page as a compact tree of roles, accessible names and `[ref=e12]` refs. Options: `interactive_only`, `scope`, `depth`, `max_chars` (a cut is always reported), `boxes`, `diff`. See [Snapshots and refs](#snapshots-and-refs). |

### Interaction

| Tool | Purpose |
|---|---|
| `click` | Scroll into view and dispatch a real pointer sequence, so framework handlers fire. `nth` picks among matches. Waits for the DOM to settle and reports `settledMs`. |
| `fill` | Set an input, textarea or contenteditable through the native setter, firing `input` and `change`. `submit: true` presses Enter afterwards. Also settles. |
| `select_option` | Choose an option by value or visible label. Also settles. |
| `press_key` | Dispatch a key press to an element or the focused element. Also settles. |
| `scroll` | Scroll the page by direction and amount, or scroll one element into view. |
| `wait_for_selector` | Poll until an element is `present`, `visible` or `absent`. |
| `wait_for_text` | Poll until any of several strings, or a regex, appears in or disappears from the page's visible text or a scope selector. |
| `fill_form` | Fill up to 50 fields in one call, each through the same checks as `fill`. Reports every field, is `ok: false` when any failed, and names which. Values are not echoed. |
| `hover` | Send `pointerover`, `pointerenter`, `mouseover`, `mouseenter`, `pointermove` and `mousemove` at an element's center. Reports `coveredBy` like `click`. CSS `:hover` styles do not change: that is browser state a script cannot set. |
| `type` | Type one character at a time (`keydown`, `keypress`, `beforeinput`, a native-setter append, `input`, `keyup`), for widgets that react to per-character events. Verifies the field afterwards: `ok: false` when characters did not go in, and the final value is reported (only its length for a password). `delay_ms` spaces the characters out. |

### Observation

| Tool | Purpose |
|---|---|
| `capture_start` | Start recording console output, uncaught errors, unhandled rejections, and `fetch` and `XMLHttpRequest` calls (method, url, status, duration; never bodies or headers). Fails with `ok: false` when the page's CSP blocks it. See [Console and network capture](#console-and-network-capture). |
| `capture_read` | Return what was recorded, oldest first, optionally clearing what it returned. Fails when no recorder is running rather than returning an empty list. |
| `network_entries` | The page's requests from the browser's own resource timing. No recorder, so it works under any CSP, with the limits listed below. |

### Spaces

| Tool | Purpose |
|---|---|
| `list_spaces` | Spaces in the front window with tab counts, which is active, and `topAppCount` for the sidebar favourites that belong to no space. |
| `focus_space` | Switch the front window to a space. Rarely needed: unfocused tabs are fully scriptable. Waits for you to stop typing. |

### Scripting

| Tool | Purpose |
|---|---|
| `execute_javascript` | Run JavaScript in a tab and return the result. Takes a bare expression or a statement body, validated before injection. |
| `batch` | Run several tools in order in one call. `continue_on_error` keeps going past a failure. |

Every tool states its full set of MCP annotations rather than leaving any to a
client's inference, because the spec's defaults are counterintuitive:
`destructiveHint` and `openWorldHint` both default to true. Read tools are
annotated read-only. Four tools are annotated destructive: `close_tab` and
`close_own_tabs`, plus `execute_javascript` and `batch`, which can do anything a
page can do. `openWorldHint` is true for everything that touches page content,
and false only for the tools that read or move Arc's own tab and space
bookkeeping.

### Local data

Read Arc's own files instead of driving Arc: see [Reading Arc's local data](#reading-arcs-local-data).
All four are read-only, never touch a page, and answer in milliseconds.

| Tool | Purpose |
|---|---|
| `sidebar_tree` | Every space with pinned items (folders nested) and unpinned tabs, plus top apps. Each tab has `id` (the `tab_id` `list_tabs` reports), `title`, `url`, `lastActiveAt`. `space`, `max_items`, `include_urls`, and `match_live` to mark each tab open or not. |
| `find_stale_tabs` | Tabs idle for `days` (default 7), oldest first, with space and `pinned` / `unpinned` / `topApp`. Also reports exact duplicate URLs across the sidebar. |
| `search_archive` | Search archived and closed tabs by text, newest first. `reason` narrows to `auto` or `manual`, `since_days` to a window. |
| `search_history` | Search browsing history by text and time window. **Off unless `ARC_MCP_ALLOW_HISTORY=1`.** |

### CDP engine

> **Security warning.** This engine talks to Arc over the Chrome DevTools
> Protocol, and Arc only serves that when **you** launch it with
> `--remote-debugging-port`. The port is **unauthenticated** and bound to
> loopback: any process running as you on this Mac can then drive Arc through
> it, read every page, and use your signed-in sessions, with no prompt. Arc never
> does this by default, nothing here turns it on for you, and a Sparkle update
> relaunches Arc without the flag. Turn the engine off with `ARC_MCP_CDP=0`, and
> close the port by relaunching Arc normally. Read
> [scripts/arc-cdp-setup.md](scripts/arc-cdp-setup.md) before enabling it.

Everything above works through Apple Events and injected JavaScript, which has
three hard limits: every event is synthetic (`isTrusted` false), there are no
screenshots, and a page's console and network are invisible. The CDP engine
removes them. It is **on by default in the server but inert until Arc exposes
the port**: the first CDP tool probes `127.0.0.1:9222` (a failed probe is
remembered for 10 seconds, so it is never paid for per call). If nothing
answers, every CDP tool returns `ok: false` with the setup steps, and every
other tool behaves exactly as before.

Setup is three commands (details, the optional launchd healer and the security
trade-off are in [scripts/arc-cdp-setup.md](scripts/arc-cdp-setup.md)):

```bash
# 1. Quit Arc (Cmd-Q). It restores your tabs.
open -a Arc --args --remote-debugging-port=9222    # 2. relaunch with the flag
curl -s 127.0.0.1:9222/json/version                 # 3. verify
arc-control-mcp --check-cdp                         # or probe with the CLI, changing nothing
```

How it fits together:

- **Tabs still come from Apple Events.** CDP only attaches to existing pages;
  it never creates a target (`Target.createTarget` crashes Arc).
- **A tab is mapped by a nonce, not by URL or title.** The Apple Event side
  writes a one-time random value into the page's DOM
  (`data-arc-mcp-tab`), and the CDP side looks for it. A target is used only
  after the nonce is found in it, so a different Chromium listening on 9222 can
  never be driven by mistake. The mapping is cached per tab and revalidated on
  every use, since a navigation drops the attribute.
- **Tab rules are unchanged.** `tab_id` works as elsewhere, and the tools that
  change a tab never fall back to the tab you are looking at.
- **Capture starts at first attach.** `console_messages` and `network_requests`
  only see what happened after a CDP tool first touched the tab. CDP has no
  history to read back, so call one before the action you want to observe.
- **Nothing sensitive is kept.** No request or response bodies, and headers are
  opt-in with `cookie`, `authorization`, `set-cookie` (and token or API-key
  style headers) redacted as they arrive. URLs are reported as they are.

| Tool | Purpose |
|---|---|
| `cdp_status` | Whether the engine can be used: port, browser, page target count, the security warning. `ok: false` with setup steps when nothing answers. |
| `screenshot` | PNG or JPEG (`quality`) as MCP image content: the viewport, `full_page` (capped at 16384 px), or one element by `selector`. Works on a background tab without bringing it forward; `activate: true` is the only way it brings one forward. |
| `trusted_click` | Real mouse click (`isTrusted` true) at the element center after scrolling it into view. `button`, `click_count` (2 gives a `dblclick`). Refuses a disabled control; reports `coveredBy`. |
| `trusted_type` | Real typing. One `insertText` by default, or `per_key: true` for keydown, keypress, input and keyup per character (search-as-you-type). `clear` replaces the contents. |
| `trusted_press_key` | Real key events with modifiers: `Enter` submits a form, `Tab` moves focus, `Meta+A` selects all. Reports the focused element afterwards. |
| `trusted_hover` | Real pointer move; reports whether `:hover` applied. |
| `drag` | Press, move in steps, release, between selectors or coordinates. Handles native HTML5 drag and drop. |
| `upload_file` | Set a file input from absolute paths. Refuses relative, missing, non-regular and credential paths (`~/.ssh`, `~/.aws`, Arc's profile, `.env`, and similar). |
| `handle_dialog` | Accept or dismiss an `alert`, `confirm`, `prompt` or `beforeunload`. Other tools report an open dialog instead of hanging. |
| `console_messages` | Buffered `console.*`, uncaught exceptions and browser log entries, filterable by `level`. |
| `network_requests` | Method, url, status, type, timing and size of each request. `include_headers` is opt-in and redacted. No bodies. |

Limits worth knowing: element selectors reach the top-level document only, not
iframes; a `Meta+` shortcut is sent with its editing command because macOS
handles those in the menu bar, not the page; and a JavaScript dialog blocks all
page access until `handle_dialog` clears it.

### Selectors

Every selector argument accepts either:

- a **CSS selector**, passed straight to `querySelectorAll`, or
- **`text=Some label`**, which matches on visible text. This is **substring**
  matching, and it is case-insensitive. Exact matches are ranked first, so
  `text=Save` prefers a button labelled exactly "Save" over one labelled "Save
  and close". Innermost matches win over their ancestors. Tools that act on a
  single element report how many matched, so a vague label is visible rather
  than silent; pass `exact: true` to require the whole text, or `nth` to pick a
  different match.

- **`ref=e12`**, a ref from `snapshot`.
- **`role=button[name="Save"]`**, an ARIA or implicit role with an exact accessible
  name, or `role=button[name~="sav"]` for a case-insensitive substring. Elements
  hidden from the accessibility tree are not matched.
- **`label=Email`** and **`placeholder=Search`**, the control a label names or the
  field carrying that placeholder. Substring, exact matches first, like `text=`.

`execute_javascript` takes either a bare expression (`document.title`) or a
statement body (`const rows = [...]; return rows.length`). Which one it used is
reported as `form`, either `"expression"` or `"statement"`. A statement body
yields a value only through `return`: `let n = 2; n * 3` comes back as `null`
with a note telling you to add one, because producing `6` there would require
`eval` inside the page and that breaks on any site with a strict
Content-Security-Policy. Broken syntax is rejected in Node with the real parser
message, before Arc is contacted at all.

The `form` field matters because it is what makes a legitimate `null`
distinguishable from a script that failed, which used to be impossible. If a value
has no useful JSON representation, for example a DOM node or `window`, the
response carries a `note` explaining that rather than a bare `{}`.

### Snapshots and refs

`snapshot` reads a page the way a screen reader would, and gives every element a
ref, so a model can act on what it read instead of guessing selectors:

```
- heading "Sign in" [level=1] [ref=e3]
- textbox "Email" [ref=e4] value="a@b.co" (required)
- button "Sign in" [ref=e5] (disabled)
```

Then `click` with `selector: "ref=e5"`. Every tool that takes a selector accepts
a ref, and also `role=`, `label=` and `placeholder=` forms.

- Roles come from ARIA or the element's implicit role. Names come from
  `aria-labelledby`, `aria-label`, a `<label>`, `alt`, `title`, `placeholder` and
  text content, capped at 100 characters. States show as `(checked, disabled,
  expanded, selected, required)`. Password values are never printed.
- Hidden subtrees (`display: none`, `aria-hidden`, `inert`) are skipped, wrappers
  with no name are folded away, and open shadow roots and same-origin iframes are
  walked. A cross-origin frame is marked as not inspected.
- Refs are stable: the same element keeps its ref across snapshots. If the page
  re-renders and replaces an element with an identical one (same role, name and
  position among identical siblings), the old ref is re-resolved and the result
  carries `reResolved: true`. If the element is gone, or the number of identical
  siblings changed so the match would be a guess, the call fails and says the ref
  is stale and to snapshot again. `wait_for_selector` with `state: "absent"` treats
  a gone ref as absent.
- `diff: true` returns `unchanged`, or the added or changed and removed lines,
  against this tab's previous snapshot with the same options.
- `boxes: true` adds `[box=x,y,w,h]` and `[in-viewport]` or `[offscreen]`, measured
  with `getBoundingClientRect`, since background tabs never run an
  `IntersectionObserver`.

Limits: refs belong to one document, so after a navigation snapshot again. A
closed shadow root cannot be read. Ref re-resolution matches on role and name, so
if rows with identical labels are reordered a ref can land on a twin, and
`reResolved` is the signal to check.

### Settling after an action

`click`, `fill`, `select_option` and `press_key` start a `MutationObserver`, act,
and then poll until the DOM has been quiet for `settle_ms` (default 300, `0` to
skip) or 1500 ms have passed. The result carries `settledMs` (when the last change
happened, relative to the action), `settled` and `mutations`. A page still
changing at the cap reports `settled: false`. The wait costs one extra
`osascript` round trip, and in a background tab the browser throttles page timers,
so a delayed update can still arrive after `settled: true`.

### The page helper library

`execute_javascript` runs with the same helper library the built-in tools use,
bound to `A`: `A.all`, `A.one`, `A.click`, `A.setValue`, `A.describe`,
`A.visible`, `A.key`. So `A.all('text=Sign in').length` works, and anything you
can do in the console you can do here.

### `batch`

Each `osascript` spawn costs a few hundred milliseconds, so batching matters
more here than it would over CDP:

```json
{"steps": [
  {"tool": "fill",  "args": {"selector": "#user", "value": "db"}},
  {"tool": "fill",  "args": {"selector": "#pass", "value": "..."}},
  {"tool": "click", "args": {"selector": "text=Sign in"}},
  {"tool": "wait_for_selector", "args": {"selector": ".dashboard"}}
]}
```

The tab is reported once for the batch rather than repeated per step, and
repeated only when it actually changes mid-batch.

Tab ids are UUID strings and are not stable across a close and reopen, so call
`list_tabs` rather than reusing an old one.

## Reading Arc's local data

Arc keeps its sidebar, archive and history in files under
`~/Library/Application Support/Arc/`. Four tools read them directly. That gives
you what Apple Events cannot report (pinned versus unpinned, folders, when a tab
was last active, the archive) and does it in milliseconds rather than the
seconds an Apple Events walk of every tab takes.

| File | Used by |
|---|---|
| `StorableSidebar.json` | `sidebar_tree`, `find_stale_tabs` |
| `StorableArchiveItems.json` | `search_archive` |
| `User Data/Default/History` (Chromium SQLite) | `search_history` |

What to know before relying on them:

- **They lag.** Arc writes these files periodically, not on every change, so a
  tab opened, closed or moved in the last minute or so may be missing or stale.
  Every result carries `asOf`, the file's modification time, and a note saying so.
  For the live truth use `list_tabs`.
- **Ids line up.** A sidebar item's `id` is the `tab_id` that `list_tabs` reports,
  so a result from `find_stale_tabs` can go straight to `close_tab`. `sidebar_tree`
  with `match_live: true` checks each tab against the open ones.
- **They fail loudly.** A missing file, invalid JSON, or a file format version this
  server was not written for (sidebar and archive: version 1) returns `ok: false`
  with the reason, never a guessed answer. A history database whose tables lack
  the columns it reads fails the same way.
- **They only read.** Nothing here writes to Arc's files. History, which Arc locks
  while it runs, is read from a temporary copy that is deleted before the call
  returns, using the `sqlite3` that ships with macOS at `/usr/bin/sqlite3`. No
  dependency is added.
- **Dates.** Arc stores seconds since 2001; results are ISO 8601 UTC.

### Privacy

These files are a complete record of what the user reads. Tab titles and URLs go
into the model's context, and from there to wherever your client sends it.

- `sidebar_tree` takes `include_urls: false` for a smaller, less revealing result.
- `search_history` is **opt-in**. Without `ARC_MCP_ALLOW_HISTORY=1` in the
  server's environment it returns `ok: false` and says how to enable it:

  ```
  claude mcp add arc --scope user -e ARC_MCP_ALLOW_HISTORY=1 -- npx -y arc-control-mcp@latest
  ```

  It only reads the `Default` profile unless you pass `profile` (a folder name
  under `User Data`, such as `Profile 1`). Hidden pages (redirects, subframes) are
  left out. Results are capped, `limit` defaults to 25 and tops out at 500.
- Set `ARC_MCP_ARC_DATA_DIR` to point the tools at another directory, for example
  a copy, or a fixture directory when testing.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `ARC_MCP_LABEL` | `default` | Names this agent's tab ownership. Two agents with different labels never see each other's owned tabs. |
| `ARC_MCP_SPACE` | `Agent` | With `ARC_MCP_WINDOW=space`, the Arc space new tabs open into, when a space with that name exists. |
| `ARC_MCP_WINDOW` | `dedicated` | `dedicated`: agent tabs live in one separate agent window. `space`: the old behaviour, tabs go into the `Agent` space of your own window. |
| `ARC_MCP_WINDOW_PLACEMENT` | `auto` | Where the agent window goes: `auto` (the largest non-main display, otherwise leave it where Arc puts it), `second-display`, `minimized` (experimental), `none`. Needs Accessibility, and is applied once, when the window is created. |
| `ARC_MCP_IDLE_MS` | `1500` | How long you must have been idle before the server does anything visible. `0` turns the gate off. |
| `ARC_MCP_IDLE_WAIT_MS` | `15000` | How long to wait for that pause before giving up with `userActive: true`. |
| `ARC_MCP_STATE_DIR` | `~/Library/Application Support/arc-control-mcp` | Where tab ownership is recorded, so a restarted agent can clean up the tabs its previous run left behind. |
| `ARC_MCP_ARC_DATA_DIR` | `~/Library/Application Support/Arc` | Where the local data tools read Arc's files from. |
| `ARC_MCP_ALLOW_HISTORY` | unset | Set to `1` to let `search_history` run. Any other value leaves it off. |

| `ARC_MCP_CDP` | on | Set to `0` to disable the [CDP engine](#cdp-engine) entirely: its tools then say so and nothing is probed. |
| `ARC_MCP_CDP_PORT` | `9222` | The DevTools port to probe on `127.0.0.1`. The host is fixed. A value that is not a port number disables the engine and says why. |
| `ARC_MCP_ALLOWED_ORIGINS` | unset | Comma list of origins the agent may touch. See [Guardrails](#guardrails). |
| `ARC_MCP_BLOCKED_ORIGINS` | unset | Comma list of origins the agent may not touch. Wins over the allow list. |
| `ARC_MCP_BLOCK_READS` | off | `1` applies both lists to read tools as well. |
| `ARC_MCP_READ_ONLY` | off | `1` exposes only the read tools. |
| `ARC_MCP_AUDIT_LOG` | unset | Path of a file that gets one JSON line per changing call. |

## Guardrails

Optional limits for an agent you do not fully trust with a browser. All are
environment variables, read once at startup, so the agent cannot loosen them
mid-session; set them in the MCP client's server config. A typo in a rule, or
an audit file that cannot be written, stops the server at startup with the
variable named, rather than leaving a guardrail silently off. `arc_status`
reports what is active, so the model knows its limits before it hits one.

```bash
claude mcp add arc --scope user \
  --env ARC_MCP_ALLOWED_ORIGINS='example.com,*.example.com,localhost:3000' \
  --env ARC_MCP_BLOCKED_ORIGINS='admin.example.com' \
  --env ARC_MCP_AUDIT_LOG="$HOME/arc-audit.jsonl" \
  -- npx -y arc-control-mcp@latest
```

**Origin rules.** An entry is `host`, `*.host`, `scheme://host[:port]`,
`file://` (any file URL) or `about:` (any URL of that scheme). A bare host
matches that exact host on any scheme and port. `*.example.com` matches
subdomains only, so list `example.com` too. Matching is on the parsed hostname,
never a substring, so `example.com.evil.test` does not match `example.com`.
With an allow list, anything not on it is refused, including a blank tab; a
block rule always wins.

- `open_url` is checked against its target URL before anything opens.
- Every other tool that changes a page (`click`, `fill`, `fill_form`, `type`,
  `hover`, `select_option`, `press_key`, `scroll`, `execute_javascript`,
  `go_back`, `go_forward`, `reload_tab`, `stop_loading`, `capture_start`) first
  reads the target tab's current URL and refuses when it is outside the rules.
  The tab it vetted is the tab it acts on, even when no `tab_id` was passed.
  This costs one extra `osascript` call per changing call. `batch` checks each
  step as it runs.
- Read tools are allowed unless `ARC_MCP_BLOCK_READS=1`.
- Tools that only manage Arc's own tabs (`close_tab`, `switch_to_tab`,
  `close_own_tabs`, `focus_space`) are not origin-gated.
- A refused call returns `ok: false`, `blocked: true`, `rule`, and an error that
  names the rule and the origin. After a navigating tool (`open_url`, back,
  forward, reload), the tab's final URL is checked again: a redirect that lands
  on a blocked origin is reported as a failure, because the navigation happened.

Limits worth knowing: the check is made before the call, so a page that
navigates itself in between is not caught until the next call. A page the agent
can already script can still send requests anywhere it likes, since the rules
cover which pages the agent drives, not what those pages' own code fetches.

**Read-only mode.** `ARC_MCP_READ_ONLY=1` advertises only the tools annotated
read-only, and answers a call to any other tool by name with a refusal.

**Audit log.** `ARC_MCP_AUDIT_LOG=<path>` appends one JSON line per changing
call: `time`, `tool`, `tab` id, `origin` (scheme and host only, never a path or
query), `ok`, and `error`. Fill values, typed text and script code are never
logged. A page's own error message can quote them, so for `fill`, `fill_form`,
`type`, `select_option` and `execute_javascript` a failure logs that it failed
without the reason. Each `batch` step is logged as its own call. Refused calls
are logged too. The file is created owner-only.

## The agent window, and the activity gate

The aim is that you can keep working in your own Arc window while an agent
browses, and that the agent never takes the keyboard from you.

### One agent window

Agent tabs live in a single dedicated Arc window, not in yours
(`ARC_MCP_WINDOW=dedicated`, the default). Its id is stored in the state
directory, shared by every label and session, and finding or creating it runs
under a cross-process lock. There is **at most one, ever**, and a new one is made
only when the stored window is truly gone. A minimized window, or one Arc merely
reports as `visible: false`, is not gone: Accessibility tells a minimized window
from a closed one, and without Accessibility the server assumes the window is
still there rather than risk a second one. The reason for the care: Arc honours
Close Window only when Arc is frontmost and the window focused, and its windows
have no Accessibility close button, so a stray window cannot be cleaned up from
here. If you do close the agent window, the next `open_url` makes a new one.

Placement (`ARC_MCP_WINDOW_PLACEMENT`, needs Accessibility, applied once at
creation so a window you move yourself stays put):

| Value | Behaviour |
|---|---|
| `auto` (default) | The largest display that is not the main one. With a single display the window is left where Arc puts it, which is visible. |
| `second-display` | Same, and says so in `agentWindow.note` when there is only one display. |
| `minimized` | **Experimental.** Minimizes the window, and minimizes it again if making a tab brought it back. Not the default because whether minimized tabs keep loading, and whether Arc un-minimizes a window for a new tab, has not been verified. |
| `none` | Never move it. |

`ARC_MCP_WINDOW=space` restores the old design: tabs go into the `Agent` space
of your window (an Arc window is not an isolation boundary, since every window
showing a space lists the same tabs, so a space is the only separation there).

Creating a window or tab raises it, and with Arc frontmost that takes keyboard
focus from the window you are typing in. `open_url` therefore records which
window had focus first and puts it back afterwards (`focusRestored: true` in the
result). Arc's own scripting cannot do that, so it goes through Accessibility.
Without Accessibility there is no placement and no restore, and `open_url`
returns an `accessibilityNote` once saying how to grant it.

### The activity gate

Before anything that can change what is on screen or which window has focus, the
server waits until you have been idle for `ARC_MCP_IDLE_MS` (1500 ms), polling
every 250 ms for up to `ARC_MCP_IDLE_WAIT_MS` (15 s). Idle time is the HID
counter from `ioreg -c IOHIDSystem`, which needs no permission. If you never
pause, the tool returns `ok: false, userActive: true` and an error saying you are
using the Mac, so the agent should retry later; nothing was opened or moved. On
success the result carries `waitedForUserMs`. `ARC_MCP_IDLE_MS=0` turns it off.

| Gated (waits for you) | Never gated (background work) |
|---|---|
| `open_url` with a new tab, `little_arc` or `activate` | Page scripting and reads on open tabs: `execute_javascript`, `click`, `fill`, `select_option`, `press_key`, `scroll`, `wait_for_*`, `get_*`, `query_elements` |
| `switch_to_tab`, `focus_space` | `list_tabs`, `list_spaces`, `get_current_tab`, `arc_status` |
| Creating the agent window, moving it, and the focus restore itself | `go_back`, `go_forward`, `reload_tab`, `open_url` with `new_tab: false`, `close_tab`, `close_own_tabs` |

`batch` is not gated as a whole, but each step goes through the same check, so a
`switch_to_tab` step waits and a `fill` step does not. If the idle time cannot be
read, the gate lets the call through and says so in `userIdleCheck`.

### What stays visible

- The agent window itself exists on screen. On a second display it is out of the
  way; on a single display with `auto` it is a window you can see.
- `open_url` raises the agent window for a moment. With Accessibility your window
  is put back in front; without it, Arc may keep the agent window focused.
- `activate: true`, `switch_to_tab` and `focus_space` are visible on purpose.
- `little_arc` opens a Little Arc window that Arc does not expose afterwards.
- Launching Arc, when it is not running, brings it up. `arc_status` and the other
  reads never launch it.
- Closing a tab you named by `tab_id` can change what its window shows, and
  closing the last tab of the agent window may close that window.
- A page can still make noise by itself (audio, a `window.open`, a dialog),
  which no tool here controls. Page scripts only move DOM focus inside the tab.

Agents are also separated from each other: each runs its own copy of the
server, ownership is tracked per session, and `ARC_MCP_LABEL` names it. One
agent's `list_tabs scope=own` and `close_own_tabs` never see another's tabs,
even when both use the same label. Tabs left behind by a dead earlier run are
reported by `arc_status` as stale and only closed if you ask, with
`close_own_tabs include_stale=true`, so a restart can never sweep away a live
sibling's tabs. All agents share the one agent window.

## Known Arc limitations

Verified in August 2026; worth retesting after an Arc update. These are Arc's
behaviour, not decisions made here.

- Setting a tab's `location` (topApp / pinned / unpinned) is marked writable but
  always fails with `-10000`, so there is no pin/unpin tool.
- Closing a window does nothing, so the server never creates windows.
- Creating a space silently no-ops, which is why the space is made by hand.
- `mode: "incognito"` is ignored when creating a window.
- Little Arc tabs never appear in `Arc.windows`, so they cannot be read or
  closed after creation.
- Closed windows linger in `Arc.windows` as invisible phantoms whose `activeTab`
  throws, so lookups filter on `visible()`.
- `space.tabs` excludes topApp favourites, so those report `space: null`.
  `list_spaces` reports `topAppCount` so its numbers reconcile with `list_tabs`.
- A bulk `window.tabs()` fetch raises `-1700`, but bulk property reads
  (`window.tabs.id()`) work and are ~10x fewer Apple Events.
- `Arc.execute` returns the JSON *encoding* of the page value, so strings arrive
  quoted and are unwrapped before being returned.
- `Arc.goBack` does nothing on a background tab, so `go_back` and `go_forward`
  go through the page's own history API instead and verify the URL changed.

### Background tabs and lazy content

A background tab reports `document.hidden`, and nothing in it ever scrolls into
view, so `IntersectionObserver` callbacks and `loading="lazy"` content can wait
forever. Some sites load a widget's code that way. On GitHub, the "Customize
your pins" dialog opens in a background tab but its list never loads, and once
it is forced to load, the script that enables "Save pins" still never runs.

`click` refuses a disabled control rather than reporting a click the page
ignored, and says when the tab is hidden. If a control stays disabled after you
have done what should enable it, `switch_to_tab` (which the user will see) and
retry.

### Limitations of synthetic events

`click`, `fill` and `press_key` dispatch synthetic events from injected
JavaScript. Widgets gated on trusted events (`event.isTrusted`) cannot be driven
that way: Arc's `execute javascript` gives no way to inject a real input event.
The [CDP engine](#cdp-engine) is the way out (`trusted_click`, `trusted_type`,
`trusted_press_key`, `drag`), but only when you have launched Arc with the
DevTools flag. Without it, use the workarounds below.

Verified against Wikipedia's search box. `fill` sets the value correctly, but
the suggestion dropdown never opens. Per-character events do not help there
either, which is why `type` exists for the widgets that do listen to them (a
handler on `input` or `keydown` that does not check `isTrusted`), not as a way
past ones that do.

The workaround does work, and is usually what you wanted anyway:

- `fill` with `submit: true`, which presses Enter and navigates, or
- navigate straight to the search URL with `open_url`.

If a widget only reacts to a suggestion list, a hover preview, or a drag, expect
it not to react to the synthetic tools; use the trusted ones.

### Loading tabs and `stop_loading`

While a tab is still loading, Arc does not answer `execute javascript`: the call
hangs until the 30 second osascript timeout, and one made during a load may
never return even after the load finishes. A hung request, or an `<iframe>`
whose server never answers, keeps a tab in that state indefinitely (measured
against Arc 1.165, with a localhost server that held a response open).
`stop_loading` presses the stop button through Arc's AppleScript `stop` command,
after which scripts work again and the page keeps what had rendered.

Arc exposes a `loading` property on every tab that answers immediately, and
`wait_for_load` reads it before asking the page anything. A tab that is loading
reports `ready: "loading"`, and a timeout says so and points at `stop_loading`,
instead of stalling for the length of the call. Other page tools are not gated on
it: call `wait_for_load` first when a click or `open_url` has just started a
navigation.

### Console and network capture

Arc runs this server's scripts in an **isolated JavaScript world**. They share
the page's DOM but not its objects: a variable the page defines is `undefined`
to them, a global they set is invisible to the page, and `console`, `fetch` and
`XMLHttpRequest` are separate copies. Wrapping `window.fetch` from
`execute_javascript` therefore records nothing the page does.

`capture_start` works around that by injecting a `<script>` element, which runs
in the page's own world, and relaying each event back to the isolated world as a
`CustomEvent` carrying JSON. What it does and does not give you:

- Records `console.log/info/warn/error/debug` text (capped at 500 characters),
  uncaught errors, failed resource loads, unhandled promise rejections, and
  `fetch` and `XMLHttpRequest` calls with method, url, status and duration.
  Never request or response bodies, never headers. The url fragment is always
  dropped and the query string is dropped unless `include_query` is set, because
  queries often carry tokens. Console text is recorded as the page logged it, so
  it can contain anything the page prints.
- **A page whose Content-Security-Policy forbids inline scripts blocks the
  injection.** That is detected, and `capture_start` fails with `ok: false` and
  the reason instead of claiming capture works. Most large sites (GitHub,
  Google) send such a policy. `capture_read` likewise fails rather than
  returning an empty list when no recorder is running.
- The recorder lives in the document: a navigation or reload discards it, so
  call `capture_start` again. It starts recording at that moment, so it misses
  requests the page made earlier. The top frame only: not iframes, workers,
  WebSockets or `sendBeacon`.
- Keeps the newest 1000 events. `capture_read` reports `dropped` when older
  ones were pushed out, and with `clear` removes only the events it returned.
- What it records comes from the page, so treat it as data, never instructions.

`network_entries` is the capture-free alternative. It reads
`performance.getEntriesByType('resource')`, which needs no injection and works
under any CSP. Its limits come from the browser: only finished requests appear
(a failed one often leaves no entry), about 250 entries are kept unless the page
raised that, cross-origin entries hide size and status unless the server sends
`Timing-Allow-Origin`, and `data:` URLs are not listed. Pass `since_ms` (from a
previous call's `nowMs`) to see only what one action caused.

## Troubleshooting

The server rewrites Arc's raw AppleScript codes into messages that name the
remedy. If you see:

| Message | What to do |
|---|---|
| `Permission denied: controlling Arc needs automation access.` | Grant Automation in System Settings, then **restart the calling app**. The permission is only re-read at launch. |
| `Arc is blocking JavaScript from Apple Events.` | Turn on "Allow JavaScript from Apple Events" in Arc > Settings > Advanced. |
| `Arc is not running. Launch Arc, or use open_url, which starts it.` | Launch Arc, or just call `open_url`. |
| `Arc is running but has no open windows.` | Arc keeps running with every window closed. Press Cmd-N. |
| `No open Arc tab has id X. Run list_tabs to get current tab ids` | The tab was closed, or the id is stale. Ids change across a close and reopen. |
| `No Arc space matches "X".` | Run `list_spaces`. Space titles are case-sensitive, and a space must be created by hand. |
| `No element on the page matches the selector "X".` | Check the page with `query_elements` first. With `text=`, remember it is substring matching on visible text only. |
| `The page script failed: SyntaxError: ...` | Your selector or code is invalid. The message is the page's own, so it says which. |
| `The page script returned nothing recognisable.` | Usually the JavaScript-from-Apple-Events permission, sometimes a tab that navigated mid-call. Retry once, then check the permission. |
| `Arc did not respond within 30s.` | Arc is showing a modal dialog (a permission prompt, a save sheet) or is stuck loading. Look at the window. |
| `Not a valid URL: X. Include a scheme, for example https://` | Prefix the URL with `https://`. |
| `Nothing is listening on 127.0.0.1:9222.` (from a CDP tool) | Arc was not launched with `--remote-debugging-port`. The result carries the steps; see [scripts/arc-cdp-setup.md](scripts/arc-cdp-setup.md). Every non-CDP tool is unaffected. |
| `Could not find this Arc tab on the DevTools port.` | The port answered, but no page carried the marker written into the tab: a different browser is on the port, or the tab is a page scripts cannot touch (`arc://`, a PDF viewer). Nothing was driven. |
| `CDP tools need Node 22 or newer` | Upgrade Node. The rest of the server runs on 20. |
| `A JavaScript dialog is open on this tab` | Call `handle_dialog`. The page cannot run anything until it is dismissed. |
| `(This is an internal arc-control error, not an Arc or page problem.)` | A bug here. Please [open an issue](https://github.com/DB-25/arc-control-mcp/issues) with the tool, arguments and full error. |

If a tool reports `ok: false` with `timedOut`, that is not an error: it is
`wait_for_load` or `wait_for_selector` telling you the condition never became
true, with `waitedMs` and what it did see.

## Layout

```
src/
  index.js       MCP wiring, --version and --help
  registry.js    composes tool modules, validates tool/handler parity at load
  jxa.js         osascript runner, Arc preamble, error mapping
  state.js       per-session tab ownership, cross-process lock
  agent-window.js  find-or-create the one agent window, focus protection
  placement.js   where the agent window goes (pure geometry)
  ax.js          Accessibility: window placement and focus
  window-config.js  ARC_MCP_WINDOW and ARC_MCP_WINDOW_PLACEMENT
  user-activity.js  the idle gate (HID idle time)
  arc-data.js    reads Arc's sidebar and archive files
  arc-history.js reads Arc's history database from a temporary copy
  policy.js      guardrails: origin rules, read-only mode, audit log
  page-lib.js    helper library injected into the page as `A`
  result.js      turns a handler result into MCP content (JSON text, or an image)
  cdp/           the DevTools engine: client, engine, tab mapping, capture, input
  tools/
    shared.js      common schemas and run helpers
    tabs.js        list, switch, close, status
    navigation.js  open, back, forward, reload, wait for load, stop loading
    open-dedicated.js  open_url into the agent window
    content.js     text, html, structured queries, links, page info
    interact.js    click, fill, select, keys, scroll, wait for selector
    input.js       fill_form, hover, type
    wait.js        wait for text
    capture.js     console and network capture, resource timing
    spaces.js      Arc spaces
    scripting.js   raw JavaScript and batch
    local.js       sidebar, stale tabs, archive and history from Arc's own files

    cdp.js         screenshots, trusted input, console and network capture
scripts/
  arc-cdp-setup.md   how to opt in, and what it costs in security
  arc-cdp-healer.sh  optional launchd helper that re-applies the flag after an update
```

Adding a module means creating `tools/<name>.js` exporting `tools` and
`handlers`, then listing it in `registry.js`. The registry throws at startup on
a duplicate name, a tool with no handler, or a handler with no tool. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Project docs

- [CHANGELOG.md](CHANGELOG.md), including what 0.3.0 fixed
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md), including the threat model: this server runs
  arbitrary JavaScript in your real logged-in browser by design
- [docs/agent-review-2026-08-31.md](docs/agent-review-2026-08-31.md), the review
  that scoped 0.3.0
- [LICENSE](LICENSE), MIT
