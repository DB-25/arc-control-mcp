# Contributing

Thanks for looking. This is a small personal project, so the bar is "does it
work against real Arc and does it not lie about what happened".

The most valuable contribution here is usually not code. It is a precise report
of an Arc quirk: what you called, what Arc did, and what it should have done.

## Setup

```bash
git clone https://github.com/DB-25/arc-control-mcp.git
cd arc-control-mcp
npm install
npm test
```

No build step. Node 20 or newer (`.nvmrc` pins the major this targets), ES
modules throughout, one runtime dependency (`@modelcontextprotocol/sdk`).

## Tests

```bash
npm test                              # unit tests, no Arc needed
ARC_MCP_INTEGRATION=1 npm test        # adds the tests that drive real Arc
```

The unit tests cover the parts that are pure Node: script composition, argument
validation, error mapping, the registry's parity check. They run anywhere,
including CI on Linux with no Arc present, and CI runs them on Node 20, 22 and 24.

Anything that actually talks to Arc cannot run in CI. Arc-dependent tests only
run on macOS with Arc installed and both permissions granted, and they skip
themselves otherwise. If you add one, make it skip rather than fail when Arc is
missing. Be aware that the integration run drives your real browser: it opens
its own tabs in the agent space and closes them again, but it is not something
to run in the middle of other work.

CI also runs `node --check` over every file in `src/`, so a syntax error cannot
merge. That check cannot see inside the template literals that hold the injected
JXA and page scripts, so those are parse-checked separately in
`test/injected-script.test.js`. If you edit `PREAMBLE` or `PAGE_LIB`, that is
the test that will catch a typo before macOS does.

## Architecture in brief

```
src/index.js       MCP wiring, --version and --help
src/registry.js    composes tool modules, validates tool/handler parity at load
src/jxa.js         osascript runner, Arc preamble, error mapping
src/state.js       per-session tab ownership
src/page-lib.js    helper library injected into the page as `A`
src/tools/*.js     one module per group of tools
```

The flow of a page-touching call:

1. A handler in `src/tools/*.js` builds a snippet of page JavaScript.
2. `page-lib.js` wraps it in the helper library and an envelope that reports
   whether it threw.
3. `jxa.js` composes that into a JXA script, binds the tool arguments to `P` as a
   JSON literal, and runs `osascript -l JavaScript`.
4. The envelope is unwrapped. A page exception becomes a real error carrying the
   page's own message.

Two rules that matter more than they look:

- **Never concatenate a tool argument into script source.** Pass it through `P`.
  Arguments come from a model and can contain anything.
- **Never report success you have not verified.** Arc dispatches commands that
  quietly do nothing (see `Arc.goBack` on a background tab). If a tool says the
  tab navigated, something has to have checked. Version 0.3.0 was almost
  entirely about undoing this class of bug, so a regression here is the worst
  kind.

## Adding a tool module

1. Create `src/tools/<name>.js` exporting two things:

   ```js
   export const tools = [ /* MCP tool definitions, with inputSchema */ ];
   export const handlers = { /* one async function per tool name */ };
   ```

2. Add it to `MODULES` in `src/registry.js`.

That is all. The registry throws at load on a duplicate tool name, a tool with
no handler, or a handler with no tool definition, so a mismatch fails at startup
rather than at call time.

Use the shared pieces in `src/tools/shared.js` (`TAB_ID`, `SELECTOR`, `VERBOSE`,
`read`, `write`, `runPage`, `runTab`) so a new tool behaves like the others:
implicit tab targeting, ownership flags, and the same annotations.

## Conventions

Match the surrounding code rather than a style guide.

- ES modules, `async`/`await`, no transpiler, no bundler.
- Small focused files: a tool module is roughly 100 to 250 lines. If one grows
  past that, it probably wants splitting.
- Comments explain **why**, not what. The reason a line exists (usually an Arc
  quirk) is the part a reader cannot reconstruct.
- Tool descriptions are written for a model that has never seen the code. Say
  what the tool is for and when to prefer it over a neighbour.
- Prefer returning a structured value over throwing for expected outcomes: a
  timeout returns `ok: false` with `timedOut`, `waitedMs` and a plain-English
  note.
- Errors that the caller can act on go through `ArcError` in `src/jxa.js` and
  should name the remedy, not just the problem.
- No new dependencies without a good reason.

## Testing against Arc by hand

The server speaks MCP over stdio, so the practical loop is to register it and
call tools from a client:

```bash
node src/index.js --help                 # tool count, no Arc needed
claude mcp add arc-dev -- node "$PWD/src/index.js"
```

Useful habits:

- Set `ARC_MCP_LABEL=dev` so your experiments do not share tab ownership with a
  running agent.
- Create an Arc space named `Agent` (or set `ARC_MCP_SPACE`) so test tabs stay
  out of the sidebar you are working in.
- `arc_status` first. It reports what the implicit target resolves to and whether
  the agent space was found.
- Finish with `close_own_tabs`.
- When something behaves oddly, reproduce it with `execute_javascript` before
  blaming the tool. That is how the `Arc.goBack` no-op was isolated:
  `history.back()` worked in the same tab where `Arc.goBack` did nothing.

## Reporting an Arc quirk

Open an issue using the bug template. What is actually needed:

- macOS version, Arc version, Node version.
- The tool called and the exact arguments.
- The full error, or the full response when the problem is that it succeeded
  when it should not have.
- If you have it: the raw Arc behaviour, for example the JXA one-liner that
  reproduces it and the AppleScript error code (`-1743`, `-10000`, `-1700` and
  friends all mean something specific here).

A confirmed quirk that cannot be worked around still belongs in the README's
known-limitations list, and a PR that adds it there is welcome on its own.

## Pull requests

- One concern per PR.
- Say what you tested and on what. "Tested by hand against Arc 1.x on macOS 15"
  is a real test plan for the Arc-facing parts.
- Add a unit test when the logic is testable without Arc, which is more of it
  than you would expect.
- Add a CHANGELOG entry under an `Unreleased` heading.
- By contributing you agree your changes ship under the MIT license.

Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security issues go to the
address in [SECURITY.md](SECURITY.md), not into a public issue.

## Releasing

Maintainer only, and mostly a note about one trap: the version is written in
**three** places, and `.github/workflows/release.yml` fails the build unless all
three match the git tag.

1. `package.json` `version`
2. `server.json` `version`
3. `server.json` `packages[0].version`

Move the CHANGELOG's `Unreleased` entries under the new version heading, tag
`v<version>`, and push the tag. The release workflow runs the tests, checks the
three versions against the tag, publishes to npm using OIDC trusted publishing
(so no npm token is stored anywhere), publishes to the MCP Registry, and creates
the GitHub release. It is gated on the `release` environment, so it waits for an
approval rather than firing on any tag push. The one-time setup that cannot be
automated is described in a comment at the top of that workflow.
