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
browser on one operating system through Apple Events. There is no screenshot
tool, no CDP, and no headless mode. There is also no Docker image, and there
cannot be one: Apple Events do not cross a container boundary, so a container
has no way to reach the Arc running on your Mac. This is a 0.3.0 personal
project, and the [known limitations](#known-arc-limitations) below are real.

## Requirements

- macOS
- [Arc](https://arc.net/) installed
- Node 20 or newer

One runtime dependency, `@modelcontextprotocol/sdk`. No build step.

## Install

> [!NOTE]
> Not on npm yet, so the `npx` commands below will fail with a 404 until the
> first release is published. Until then, use the "From a git checkout"
> instructions at the end of this section. Delete this note once
> `arc-control-mcp` is published.

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
- **No focus stealing**: Arc auto-selects a newly created tab, so `open_url`
  puts the previous selection back, and only when Arc actually took it. If the
  user switched tabs while the page was opening, their choice stands. Pass
  `activate: true` to opt out.
- **Background tabs are fully usable**: tabs in an unfocused space still load,
  render and script normally, so nothing needs to be brought to the front.

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

26 tools in six modules.

### Tabs

| Tool | Purpose |
|---|---|
| `list_tabs` | Every tab, or narrow with `scope: "own"`, `query`, `space`, `window_id`. Rows are flagged `mine` and `isActive`. |
| `get_current_tab` | The tab a call with no `tab_id` would act on. |
| `switch_to_tab` | Make a tab active in its window. `activate` also brings Arc to the front. |
| `close_tab` | Close one tab. |
| `close_own_tabs` | Close every tab this agent opened, leaving the user's alone. `include_stale` also closes tabs leaked by a dead previous run of the same label. |
| `arc_status` | Owned tabs, whether the agent space exists, what a call with no `tab_id` resolves to (reported separately for read-only and for changing tools), and how many stale tabs a previous run left behind. |

### Navigation

| Tool | Purpose |
|---|---|
| `open_url` | Open a URL, launching Arc if needed. Options for `new_tab`, target `space`, `little_arc`, `activate`, `wait_until_loaded`. |
| `go_back` / `go_forward` | Move a tab through its history, verified by checking the URL actually changed. |
| `reload_tab` | Reload a tab. |
| `wait_for_load` | Poll until the document is ready, optionally until the URL contains a substring. |

### Content

| Tool | Purpose |
|---|---|
| `get_page_content` | Visible text, whole page or every element matching a selector, joined. Always reports `matched`, so a partial answer is never silent, and flags truncation. |
| `get_html` | Markup for the page or one element, outer or inner. Reports how many matched and takes `nth` to pick another. |
| `query_elements` | Structured details per element: text, value, href, visibility, attributes. Reports `total` alongside `returned`. The main way to see what is on a page before acting. |
| `get_links` | Links with text and resolved href, filterable by substring. |
| `get_page_info` | Title, URL, ready state, meta description, a headings outline, and counts of links, forms, inputs, buttons and iframes. A cheap first look at an unfamiliar page. |

### Interaction

| Tool | Purpose |
|---|---|
| `click` | Scroll into view and dispatch a real pointer sequence, so framework handlers fire. `nth` picks among matches. |
| `fill` | Set an input, textarea or contenteditable through the native setter, firing `input` and `change`. `submit: true` presses Enter afterwards. |
| `select_option` | Choose an option by value or visible label. |
| `press_key` | Dispatch a key press to an element or the focused element. |
| `scroll` | Scroll the page by direction and amount, or scroll one element into view. |
| `wait_for_selector` | Poll until an element is `present`, `visible` or `absent`. |

### Spaces

| Tool | Purpose |
|---|---|
| `list_spaces` | Spaces in the front window with tab counts, which is active, and `topAppCount` for the sidebar favourites that belong to no space. |
| `focus_space` | Switch the front window to a space. Rarely needed: unfocused tabs are fully scriptable. |

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

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `ARC_MCP_LABEL` | `default` | Names this agent's tab ownership. Two agents with different labels never see each other's owned tabs. |
| `ARC_MCP_SPACE` | `Agent` | The Arc space new tabs open into, when a space with that name exists. |
| `ARC_MCP_STATE_DIR` | `~/Library/Application Support/arc-control-mcp` | Where tab ownership is recorded, so a restarted agent can clean up the tabs its previous run left behind. |

## Isolation, and why not a separate window

An Arc window is not an isolation boundary. Every window showing a space shares
that space's whole tab list, so a second window displays the same tabs.
Verified: a scripted new window listed the same 27 tabs as the original.

The only real boundary is a **space**. Create one named `Agent` (or set
`ARC_MCP_SPACE`) and every tab this server opens goes there, out of the sidebar
you are working in. Without it, tabs open in the main window alongside yours;
everything still works, they are just visible. `arc_status` reports which mode
is active.

Agents are separated from each other as well: each runs its own copy of the
server, ownership is tracked per session, and `ARC_MCP_LABEL` names it. One
agent's `list_tabs scope=own` and `close_own_tabs` never see another's tabs,
even when both use the same label. Tabs left behind by a dead earlier run are
reported by `arc_status` as stale and only closed if you ask, with
`close_own_tabs include_stale=true`, so a restart can never sweep away a live
sibling's tabs. Agents do still share the one `Agent` space in the sidebar,
since Arc will not let a script create a space.

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

### Limitations of synthetic events

Everything this server does in a page is a synthetic event, dispatched from
injected JavaScript. Widgets gated on trusted events (`event.isTrusted`) cannot
be driven that way, and there is no workaround inside this design: Arc's
`execute javascript` gives no CDP access, so there is no way to inject a real
input event.

Verified against Wikipedia's search box. `fill` sets the value correctly, but
the suggestion dropdown never opens. Hand-dispatching per-character
`keydown`/`input`/`keyup` does not help either.

The workaround does work, and is usually what you wanted anyway:

- `fill` with `submit: true`, which presses Enter and navigates, or
- navigate straight to the search URL with `open_url`.

If a widget only reacts to a suggestion list, a hover preview, or a drag, expect
it not to react here.

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
  state.js       per-session tab ownership
  page-lib.js    helper library injected into the page as `A`
  tools/
    shared.js      common schemas and run helpers
    tabs.js        list, switch, close, status
    navigation.js  open, back, forward, reload, wait for load
    content.js     text, html, structured queries, links, page info
    interact.js    click, fill, select, keys, scroll, wait for selector
    spaces.js      Arc spaces
    scripting.js   raw JavaScript and batch
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
