*This is the agent review that prompted version 0.3.0. It is kept here as a
record of how the release was scoped. The findings it describes are fixed as of
0.3.0: see [CHANGELOG.md](../CHANGELOG.md) for what changed. The one item that
was not a bug, synthetic events being unable to drive widgets that require
trusted events, is documented as a limitation in the
[README](../README.md#limitations-of-synthetic-events).*

---

# arc-control-mcp: agent-side review, 2026-08-31

Written by an agent that drove the server end to end: opened tabs in the Agent
space, filled and submitted a real form, navigated history, ran scripts, walked
the error paths, and cleaned up after itself. Another agent was using Arc
concurrently throughout.

Verdict: the happy path is genuinely good. Almost every problem below traces
back to one line, `src/jxa.js:116`, which turns page-script failures into
successes.

---

## 1. Critical: a page-script exception is reported as success

`evalJs` collapses an empty, `undefined` or `null` result from `Arc.execute`
into `null`:

```js
// src/jxa.js:116
if (raw === undefined || raw === null || raw === "") return null;
```

Arc returns empty when the injected script throws. Every handler then does
`return { ok: true, ...result, tab }`, and spreading `null` contributes nothing,
so a thrown script becomes a bare `{ ok: true }`.

Observed: a four-step batch in which **nothing at all happened** reported
`ok: true` on every step and at the top level.

| step | call | response |
|---|---|---|
| 0 | `click` selector `div:has(` | `{ ok: true }` |
| 1 | `query_elements` selector `a::foo` | `{ selector: "a::foo" }`, no `elements`, no `total` |
| 2 | `get_page_content` selector `>>bad` | `{ tab: ... }`, no `text` field at all |
| 3 | `fill` on an `<h1>` | `{ ok: true }`, no `filled` |

All three selectors throw `SyntaxError` in WebKit, and `A.setValue` on an `<h1>`
throws `Illegal invocation`. An agent reading these proceeds believing the form
is filled and the button clicked. This is the worst available failure mode for
browser automation, and it is invisible.

Note that a genuinely invalid selector and a genuinely absent element are
indistinguishable, so an agent with a typo'd selector will loop hunting for an
element that was never the problem.

**Fix.** Return a structured envelope from the page instead of a bare value, so
"threw" and "returned nothing" stop being the same thing:

```js
// page-lib.js
export function pageScript(body) {
  return `${PAGE_LIB}
(function(){
  try { return JSON.stringify({ __ok: true, v: (function(){ ${body} })() }); }
  catch (e) { return JSON.stringify({ __ok: false, name: e && e.name, error: String((e && e.message) || e) }); }
})()`;
}
```

Then unwrap in `runPage` and raise an `ArcError` when `__ok === false`. With the
envelope, a legitimate `undefined` return still arrives as `{__ok: true}`, so
the ambiguity disappears. Every handler's `return { ok: true, ...result }`
becomes safe, and all four rows above turn into real errors for free.

## 2. Critical: `execute_javascript` breaks on any statement body

```js
// src/tools/scripting.js:55
const body = /(^|[\s;{])return[\s;]/.test(args.code) ? args.code : `return (${args.code});`;
```

Code without the literal word `return` is wrapped as `return (code)`, which is a
syntax error for anything that is not a single expression. Combined with finding
1, the agent gets `null` and no hint.

Observed:

- `let n = 2; n * 3` returned `null`. Should be `6`.
- `throw new Error('boom')` returned `{ result: null }`, as did a deliberate
  redeclaration syntax error. Three different failures, one indistinguishable
  answer.

**Fix.** Try the expression form, fall back to the statement form, in the page:

```js
var fn;
try { fn = new Function('A', 'return (' + BODY + ');'); }
catch (e) { fn = new Function('A', BODY); }
```

## 3. High: `go_back` silently does nothing, and history tools never verify

`Arc.goBack(tab)` is a no-op on a background tab. Reproduced three times on a
tab with `history.length === 2` and a real back entry: the URL never changed,
across polls out to 4 seconds. `go_forward` and `reload_tab` both work on the
same tab, so the asymmetry is in Arc's `goBack` specifically.

`history.back()` through `execute_javascript` worked instantly on that same
background tab.

Separately, the wrapper reports success unconditionally:

```js
// src/tools/navigation.js:95-103
Arc.${command}(tab);
delay(0.4);
JSON.stringify({ ok: true, action: ${verb}, tab: describe(tab) });
```

Two problems. `ok: true` means "the command was dispatched", not "the tab
moved". And `describe(tab)` at 400ms captures the pre-navigation URL, so even
when the navigation does work the returned snapshot is stale and contradicts it.
In my first batch, `go_back` said `{ok: true, action: "went back"}` and the very
next `get_page_info` showed the old page.

**Fix.** Implement all three through the page (`history.back()`,
`history.forward()`, `location.reload()`), which is verified to work here. At
minimum: capture `location.href` before, poll after, and return
`{ ok: false, note: "url did not change" }` when it didn't.

## 4. High: concurrent agents on the same label corrupt each other's ownership

```js
// src/state.js:23
const state = load();
```

The in-process owned set is *seeded from the shared file*, which defeats the
isolation the comment above it claims:

> Each agent runs its own copy of this server, so an in-process set of tab ids
> already separates one agent from another.

With two agents both on the default label, whichever starts second adopts the
first's tabs as its own, and whichever writes second drops the first's tabs from
disk. Demonstrated with two processes importing the real module:

```
AGENT-A-TAB -> in-process owned: [..., 'AGENT-A-TAB']
AGENT-B-TAB -> in-process owned: [..., 'AGENT-B-TAB']
file on disk: owned: [..., 'AGENT-B-TAB']     # A's tab gone
```

Consequences: `close_own_tabs` from one agent can close another agent's tabs,
and restart cleanup leaks whatever was dropped. Both agents also land in the
same `Agent` space, so there is no separation in the UI either.

**Fix.** Either scope the file per process (`default-<pid>.json`) or stop
adopting the file's contents as owned. Keeping it purely as a reap list, read
explicitly at cleanup time rather than merged into `owned` at import, preserves
the stated design. Defaulting `ARC_MCP_LABEL` to something per-session would
also help.

## 5. Medium: `get_page_content` with a selector silently returns one match

```js
// src/tools/content.js:75
var el = sel ? A.one(sel) : document.body;
```

`length` and `truncated` then describe that one element. Asking for
`#mw-content-text p` on a Wikipedia article with 19 paragraphs returned 523
characters with `truncated: false`, i.e. the lead paragraph presented as the
complete answer. Nothing in the response says 18 more matched.

`query_elements` gets this right, reporting `total` alongside `returned`. Match
that: join all matches, or keep first-match behaviour but report
`matched: 19, usedFirst: true`.

## 6. Medium: `fill` succeeds on things that cannot be filled

`fill` on an `<h1>` returned `ok: true` with no `filled` key. `A.setValue`
(`page-lib.js:85`) calls the `HTMLInputElement.prototype` value setter on
whatever it is handed, which throws for a non-input, and finding 1 hides it.
Guard the element type and return a real error naming the tag.

## 7. Medium: the response envelope is heavy, and `batch` multiplies it

Every step in a batch repeats the full `tab` object, including the URL. On the
form-submission page that URL was ~300 characters of query string, repeated nine
times in one response, describing a tab that never changed.

Also: `click` and `fill` return the entire `A.describe()` payload including
`rect` and every attribute, and `press_key` returns 400 characters of the body's
innerText as its `target`. Individually fine, cumulatively expensive in the
place where context matters most.

Suggest: emit `tab` once at the batch level and only repeat it when it actually
changes mid-batch; trim `describe` to tag/text/value/visible/disabled by
default, with a `verbose` opt-in.

## 8. Polish

1. **`text=` is substring matching and is not documented as such.**
   `text=Claude` matched 37 elements and clicked the first in DOM order. The
   count is reported (good), but exact matches should sort ahead of substring
   matches, and the schema description should say "substring". An `exact: true`
   option would help.
2. **`A.visible` under-rejects.** It only bails when width and height are both
   zero (`page-lib.js:38`), so the standard 1×1 clipped screen-reader element
   passes. `text=Adoption` returned a 1×1 "Toggle Adoption subsection" span as
   `visible: true`, a plausible thing to click by accident. Add a minimum size,
   or check `clip`/`overflow`.
3. **Stale tab snapshots after navigation-triggering calls.** `click` labels its
   snapshot `urlBefore`, which is honest. `fill` with `submit: true` does not,
   and returned a pre-navigation URL after successfully navigating. Either add
   `wait_until_loaded` to these or name the field so it reads as "before".
4. **No way to open a new window.** `mainWindow()` is hardcoded throughout and
   `list_spaces` only covers the front window. Isolation is space-only, so two
   concurrent agents share one `Agent` space. A `new_window` option on
   `open_url`, or an `isolation: window` mode, is the natural answer, and was
   the thing I actually wanted when told to stay out of another agent's way.
5. **`list_spaces` counts do not reconcile with `list_tabs`.** Space tab counts
   exclude `topApp` tabs: 9 reported against 21 real tabs. The README explains
   why, but the tool output should carry a `topAppCount` so the arithmetic is
   visible without reading the docs.
6. **Non-serializable returns vanish quietly.** `return window` yields
   `result: {}` with no note.
7. **No screenshot tool.** Everything is text and DOM. Fine for most work, but
   there is no way to verify that anything *looks* right, which rules out visual
   or CSS verification.
8. **`open_url` returns `loaded: false` without failing.** Worth surfacing more
   loudly, since an agent may act on a half-loaded page.

---

## Known limitation, not a bug

`fill` could not open Wikipedia's search suggestions. Neither could
per-character synthetic `keydown`/`input`/`keyup` dispatched by hand. Widgets
gated on trusted events are unreachable without CDP, which `Arc.execute
javascript` does not provide. Worth stating in the README along with the
workaround, which does work: `fill` with `submit: true` navigated correctly, as
does going straight to the search URL.

## What works well

Genuinely good, and worth not regressing:

- **The bad-`tab_id` error.** "No open Arc tab has id X. Run list_tabs to get
  current tab ids (they change when a tab is closed and reopened)." Explains the
  failure, the recovery, and the underlying cause. Best error in the server.
- **Honest timeouts.** `wait_for_selector` and `wait_for_load` return
  `ok: false` with `timedOut`, `waitedMs`, `count`, `visible` and a plain-English
  note. `wait_for_load` was the only tool that caught the `go_back` no-op.
- **No focus stealing.** `restoredUserTab: true` on every `open_url`. The user's
  tab never moved, across roughly 20 calls, with another agent working alongside.
- **Ownership flags held up under concurrency.** The other agent's tabs read
  `mine: false` throughout, and `close_own_tabs` closed exactly my one remaining
  tab and left theirs alone.
- **`batch` is the right primitive.** Six-step form fill, verified, in one round
  trip. `continue_on_error` behaves as documented.
- **Read tools report the metadata an agent needs to reason about truncation:**
  `total: 753` links, `pageHeight`/`scrollY`/`viewport`, `truncated` flags.
- **The interaction layer is well built.** The native-setter `fill` worked on
  Vue/Codex inputs; `select_option` by visible label worked; the synthetic
  pointer sequence in `A.click` fired real framework handlers, and the form
  submitted with every field's value intact.
- **Background tabs really are fully usable**, exactly as the README claims, for
  everything except `Arc.goBack`.

## Suggested order

1. The error envelope (finding 1). It is one function and it converts findings
   1, 2, 6 and part of 5 from silent corruption into visible errors.
2. `execute_javascript` statement handling (finding 2).
3. `go_back` and history verification (finding 3).
4. State file isolation (finding 4), before two agents run concurrently again.
5. Envelope trimming (finding 7) and the polish list.
