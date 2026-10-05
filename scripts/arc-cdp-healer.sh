#!/bin/bash
# Re-applies Arc's DevTools flag when Arc has just been (re)started without it.
#
# Meant to run every 30 seconds from a LaunchAgent (see
# scripts/company.thebrowser.arc-cdp-healer.plist.template and
# scripts/arc-cdp-setup.md). It is deliberately timid. It acts only when ALL of
# these hold, so it never interrupts someone mid-session:
#   1. Arc is running,
#   2. nothing answers on the DevTools port,
#   3. the Arc process is younger than ARC_CDP_HEALER_FRESH_SECONDS (default 180),
#      meaning it was just launched by the user or relaunched by a Sparkle update,
#   4. nobody has touched the keyboard or mouse for ARC_CDP_HEALER_IDLE_SECONDS
#      (default 5), so Arc is never quit under someone who is using it.
# Then it quits Arc gracefully through AppleScript and reopens it with
#   open -a Arc --args --remote-debugging-port=PORT
# Arc restores the session on launch.
#
# It will not repeat itself: after one attempt it waits ARC_CDP_HEALER_COOLDOWN_SECONDS
# (default 600) before another. If Arc ignores the flag on this profile, that
# stops it quitting Arc every few minutes forever.
#
# Environment (all optional):
#   ARC_MCP_CDP_PORT                  port to enforce (default 9222)
#   ARC_CDP_HEALER_FRESH_SECONDS      how young Arc must be to count as just started
#   ARC_CDP_HEALER_COOLDOWN_SECONDS   minimum gap between attempts
#   ARC_CDP_HEALER_LOG                log file (default ~/Library/Logs/arc-cdp-healer.log)
#   ARC_CDP_HEALER_STATE              last-attempt file
#   ARC_CDP_HEALER_DRY_RUN=1          log what it would do, change nothing

set -u

PORT="${ARC_MCP_CDP_PORT:-9222}"
FRESH_SECONDS="${ARC_CDP_HEALER_FRESH_SECONDS:-180}"
IDLE_SECONDS="${ARC_CDP_HEALER_IDLE_SECONDS:-5}"
COOLDOWN_SECONDS="${ARC_CDP_HEALER_COOLDOWN_SECONDS:-600}"
QUIT_WAIT_SECONDS="${ARC_CDP_HEALER_QUIT_WAIT_SECONDS:-20}"
LOG="${ARC_CDP_HEALER_LOG:-$HOME/Library/Logs/arc-cdp-healer.log}"
STATE="${ARC_CDP_HEALER_STATE:-$HOME/Library/Application Support/arc-control-mcp/cdp-healer-last}"
DRY_RUN="${ARC_CDP_HEALER_DRY_RUN:-0}"

mkdir -p "$(dirname "$LOG")" "$(dirname "$STATE")"
log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"; }

# ps prints elapsed time as [[dd-]hh:]mm:ss (macOS ps has no etimes).
etime_to_seconds() {
  local t="$1" days=0 h=0 m=0 s=0
  case "$t" in *-*) days="${t%%-*}"; t="${t#*-}";; esac
  IFS=: read -r a b c <<< "$t"
  if [ -n "${c:-}" ]; then h="$a"; m="$b"; s="$c"; else m="$a"; s="${b:-0}"; fi
  echo $(( 10#$days * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s ))
}

# The oldest process named exactly "Arc" is the main app; helpers have longer names.
ARC_PID="$(pgrep -x -o Arc 2>/dev/null || true)"
[ -z "$ARC_PID" ] && exit 0

if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/json/version" > /dev/null 2>&1; then
  exit 0
fi

ETIME="$(ps -o etime= -p "$ARC_PID" 2>/dev/null | tr -d ' ')"
[ -z "$ETIME" ] && exit 0
AGE="$(etime_to_seconds "$ETIME")"
if [ "$AGE" -ge "$FRESH_SECONDS" ]; then
  # A long-running Arc without the flag is a session in use. Leave it alone.
  exit 0
fi

# Quitting Arc while someone types into it would lose what they typed. Wait
# for a pause; the next run 30 seconds later tries again within the window.
IDLE_NS="$(ioreg -c IOHIDSystem -d 4 2>/dev/null | awk '/HIDIdleTime/ {print $NF; exit}')"
if [ -n "$IDLE_NS" ] && [ $(( IDLE_NS / 1000000000 )) -lt "$IDLE_SECONDS" ]; then
  log "wait: Arc started ${AGE}s ago without port ${PORT}, but the user is active. Trying again on the next run."
  exit 0
fi

NOW="$(date +%s)"
LAST="$(cat "$STATE" 2>/dev/null || echo 0)"
if [ $(( NOW - LAST )) -lt "$COOLDOWN_SECONDS" ]; then
  log "skip: Arc started ${AGE}s ago without port ${PORT}, but a restart was already tried $(( NOW - LAST ))s ago. Does this Arc build ignore the flag? Run: arc-control-mcp --check-cdp"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  log "dry run: would quit Arc (pid ${ARC_PID}, up ${AGE}s) and reopen it with --remote-debugging-port=${PORT}"
  exit 0
fi

echo "$NOW" > "$STATE"
log "Arc (pid ${ARC_PID}) started ${AGE}s ago without port ${PORT}: quitting it gracefully and reopening with the flag"
osascript -e 'tell application "Arc" to quit' >> "$LOG" 2>&1

waited=0
while pgrep -x Arc > /dev/null 2>&1; do
  if [ "$waited" -ge "$QUIT_WAIT_SECONDS" ]; then
    # Never force-kill: a dialog may be waiting on the user, and a kill loses state.
    log "gave up: Arc did not quit within ${QUIT_WAIT_SECONDS}s, so it was left running"
    exit 0
  fi
  sleep 1
  waited=$(( waited + 1 ))
done

open -a Arc --args "--remote-debugging-port=${PORT}" >> "$LOG" 2>&1
log "reopened Arc with --remote-debugging-port=${PORT}"
