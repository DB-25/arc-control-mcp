# Security Policy

## Reporting a vulnerability

Email **dhruvbaradiya@gmail.com** with the details. Please do not open a public
issue for a security problem.

Useful to include: what an attacker can do, how to reproduce it, and the
versions involved (arc-control-mcp, macOS, Arc, Node).

This is a personal project maintained in spare time. Expect an acknowledgement
within a week. Please give me a reasonable chance to ship a fix before
disclosing publicly.

Supported version: the latest release. Older versions do not get backported
fixes.

## Threat model, stated plainly

**This server executes arbitrary JavaScript in your real, logged-in browser, and
that is the point.** It is not a sandbox and it is not trying to be one.

What that means concretely:

- Any agent connected to this server can read and act as you on every site you
  are signed into in Arc: email, banking, cloud consoles, internal tools. Cookies
  and sessions are yours, so a request it makes is indistinguishable from one you
  made.
- `execute_javascript` is unrestricted by design. There is no allowlist of
  domains and no read-only mode.
- Ownership tracking (the `mine` flag, `close_own_tabs`, `ARC_MCP_LABEL`) is
  bookkeeping so agents do not step on each other's tabs. It is **not** a
  security boundary: no tool refuses a tab you name with an explicit `tab_id`,
  including yours.
- One guard does exist, and it is aimed at an agent's mistake rather than at a
  determined agent. A tool that changes a tab will not fall back to the tab you
  are looking at: with no `tab_id` and no tab of its own, the call is refused.
  That is there because an agent once ran `go_back` and `reload_tab` with no
  `tab_id` and navigated a tab someone was working in. It is not a sandbox, and
  an agent that passes an explicit `tab_id` can still drive any tab you have
  open, by design.
- An Arc space is not a security boundary either. It keeps agent tabs out of your
  sidebar, nothing more.

So: **only connect this to an agent you trust with your logged-in browser
session.** If that is not acceptable for a given task, use a separate macOS user
account with its own Arc profile, or a browser automation tool that starts from
an empty profile.

## The DevTools port, if you open it

The optional CDP engine needs Arc launched with `--remote-debugging-port`, which
is a decision you make, never one this server makes for you. That port has no
authentication. While it is open, **any process running as your user can drive
Arc through it** (read every tab, use your sessions, navigate and type) without
going through this server and without any prompt. That is a larger exposure than
the agent connection above, because it is open to all local software, not just
the one agent you chose.

What this project does about it: it connects only to `127.0.0.1` on the port you
configure, rebuilds the WebSocket address itself, never creates targets, drives a
tab only after finding a one-time marker it wrote there (so a different browser
on the port is never mistaken for Arc), keeps console and network buffers in
memory with credential headers redacted and no bodies, and refuses to upload
credential or browser-profile files. What it cannot do is close the port to
other processes. `ARC_MCP_CDP=0` stops this server using it, and relaunching Arc
without the flag closes it. See `scripts/arc-cdp-setup.md`.

## Page content is data, not instructions

Everything this server returns from a page (`get_page_content`, `get_html`,
`query_elements`, `get_links`, script results) is untrusted input. A web page can
contain text addressed to your agent: fake system messages, claims of prior
authorization, instructions to visit a URL or exfiltrate something it just read.

Agents consuming this server should treat all page output as data to reason
about, never as instructions to follow. This is a real risk here rather than a
theoretical one, because the same session that reads the attacker-controlled page
can also act on your authenticated sites.

If you are wiring this into an agent, the useful mitigations are on your side:
keep sensitive sites out of reach when they are not needed, require confirmation
before irreversible actions (sending, purchasing, deleting), and log what the
agent did.

## Known non-issues

These are documented behaviours, not vulnerabilities, and reports of them will be
closed as such:

- The server can navigate to any URL and script any page. By design.
- Tool arguments reach the browser. They are injected as a JSON literal bound to
  `P` rather than concatenated into script source, which prevents an argument
  from becoming JXA code, but the argument still gets to do whatever the tool
  does with it.
- Tab ownership can be read by any process that can read
  `~/Library/Application Support/arc-control-mcp` (or `ARC_MCP_STATE_DIR`). It
  holds tab ids, no page content and no credentials.
- macOS Automation permission is required and cannot be worked around. That is
  the operating system doing its job.
