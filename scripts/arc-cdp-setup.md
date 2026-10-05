# Turning on Arc's DevTools port

This is documentation, not automation. Nothing in arc-control-mcp changes how
Arc launches. You do it yourself, once, and you can undo it by relaunching Arc.

## What it gives you, and what it costs

With the port open, arc-control-mcp can take screenshots, send trusted input
(`isTrusted` true), handle JavaScript dialogs, and record each tab's console and
network activity. Without it, none of those tools work and every other tool is
unaffected: they report `ok: false` with these steps and nothing else changes.

**The cost is real.** The DevTools port is unauthenticated and bound to loopback.
While Arc is running with it, any process running as your user on this Mac can:

- list and read every tab, including pages you are signed in to,
- run JavaScript in them with your cookies and sessions,
- navigate, click and type as you.

There is no prompt and no token. A malicious npm package, a compromised dev
tool, or a malicious page that finds a way to a local request is enough. This is
why Arc does not enable it by default. Turn it on only if you accept that, and
consider turning it off when you are not using an agent.

arc-control-mcp narrows what it will touch (it connects only to `127.0.0.1`, never
creates targets, and drives a tab only after finding a one-time marker it wrote
into that tab), but it cannot narrow what other local software can do with an
open port.

## Enable it

1. **Quit Arc completely** (Cmd-Q, not just closing windows). Arc restores your
   tabs and spaces when it comes back.
2. **Relaunch it with the flag:**

   ```bash
   open -a Arc --args --remote-debugging-port=9222
   ```

3. **Verify:**

   ```bash
   curl -s 127.0.0.1:9222/json/version
   ```

   You should get JSON naming the browser and a `webSocketDebuggerUrl`. Or run
   `arc-control-mcp --check-cdp`, which only probes the port and prints what it
   finds (exit code 0 when it answers, 1 when not). It changes nothing.

4. In your MCP client, call `cdp_status`. It reports the port, the browser and
   how many page targets are visible.

The engine probes port 9222 by default. To use another port, launch Arc with
that port and set `ARC_MCP_CDP_PORT` for the MCP server. To switch the engine
off altogether, set `ARC_MCP_CDP=0`.

### If nothing answers

Chrome 136 and later ignore `--remote-debugging-port` on the default profile
unless a `--user-data-dir` is also given. Arc is built on Chromium, and whether
it behaves the same way is not something this project has verified. If step 3
returns nothing after a clean relaunch, that is the likely cause. `cdp_status`
and `--check-cdp` report "nothing listening" rather than guessing. Please open an
issue with your Arc version if you hit it.

## Disable it

Quit Arc and open it normally (Dock, Spotlight, or `open -a Arc` with no
arguments). The port is gone. If you installed the healer below, uninstall it
first or it will put the flag back.

## Keeping the flag after updates (optional)

Arc updates itself with Sparkle, which relaunches Arc without your flag, so the
port silently disappears after each update. `arc-cdp-healer.sh` puts it back.

It runs every 30 seconds from a LaunchAgent and does nothing unless **all** of
these are true: Arc is running, the port is closed, and Arc's process started
less than 90 seconds ago (it was just launched by you or by an update). Then it
quits Arc gracefully through AppleScript and reopens it with the flag. A
long-running Arc without the flag is a session in use, so it is left alone. After
one attempt it waits 10 minutes before trying again, so an Arc that ignores the
flag is not quit in a loop. It never force-kills Arc, and it logs to
`~/Library/Logs/arc-cdp-healer.log`.

Be aware of what that means: **launching Arc from the Dock without the flag will
make the healer quit and relaunch it about 30 seconds later.** Your session is
restored, but it is a visible restart. That is the price of the port surviving
updates. Skip the healer if you would rather relaunch by hand.

Nothing here installs it for you. To install:

```bash
# 1. Keep a stable copy of the script (an npx cache path moves between versions).
mkdir -p "$HOME/Library/Application Support/arc-control-mcp"
cp scripts/arc-cdp-healer.sh "$HOME/Library/Application Support/arc-control-mcp/"
chmod +x "$HOME/Library/Application Support/arc-control-mcp/arc-cdp-healer.sh"

# 2. Fill in the plist template.
sed -e "s|__SCRIPT_PATH__|$HOME/Library/Application Support/arc-control-mcp/arc-cdp-healer.sh|" \
    -e "s|__HOME__|$HOME|g" \
    scripts/company.thebrowser.arc-cdp-healer.plist.template \
    > "$HOME/Library/LaunchAgents/company.thebrowser.arc-cdp-healer.plist"

# 3. Check it, then load it.
plutil -lint "$HOME/Library/LaunchAgents/company.thebrowser.arc-cdp-healer.plist"
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/company.thebrowser.arc-cdp-healer.plist"
```

To try it without any effect first, run the script by hand in dry-run mode and
read the log:

```bash
ARC_CDP_HEALER_DRY_RUN=1 bash scripts/arc-cdp-healer.sh
tail "$HOME/Library/Logs/arc-cdp-healer.log"
```

To uninstall:

```bash
launchctl bootout "gui/$UID/company.thebrowser.arc-cdp-healer"
rm "$HOME/Library/LaunchAgents/company.thebrowser.arc-cdp-healer.plist"
rm "$HOME/Library/Application Support/arc-control-mcp/arc-cdp-healer.sh"
```

To use another port, uncomment the `ARC_MCP_CDP_PORT` entry in the plist (it must
match the server's `ARC_MCP_CDP_PORT`). The thresholds can be changed with
`ARC_CDP_HEALER_FRESH_SECONDS` and `ARC_CDP_HEALER_COOLDOWN_SECONDS`.

## What the server does with the port

- Connects only to `127.0.0.1`, on the port you chose. It rebuilds the WebSocket
  address from that host and port rather than trusting the one the endpoint
  reports.
- Never calls `Target.createTarget` (it crashes Arc). Tabs are still opened
  through Apple Events; CDP only attaches to pages that exist.
- Finds the CDP target for an Arc tab by writing a random one-time marker into
  the page through Apple Events and looking for it over CDP. A page without the
  marker is never driven, so another Chromium on the same port cannot be
  mistaken for Arc.
- Buffers console and network events only for tabs a CDP tool has touched, in
  memory, capped, with credential headers redacted and no bodies.
- Refuses to upload relative paths, missing files, directories, and credential
  or browser-profile files.
- Needs Node 22 or newer, for the built-in `WebSocket`. On older Node the CDP
  tools say so and the rest of the server works.
