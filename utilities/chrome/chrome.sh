#!/usr/bin/env sh
# The real-Chrome stage of evidence-mcp's download (config.json
# FH_CHROME_1: 127.0.0.1 on the same machine, or the host's
# tailnet name from another). Starts Google Chrome with ITS OWN profile and the
# DevTools port; a second call while it runs does nothing.
#
# Run it as a user SERVICE (utilities/chrome/fh-chrome.service): Restart=always brings
# Chrome back when it dies or updates itself. Not as a Hyprland exec/uwsm app:
# a Chrome launched in such a transient scope died 7–14 s later every time
# (2026-10-28), while one under a service or a plain shell runs on. The script
# stays in the foreground for as long as Chrome runs; from a terminal, --detach.
#
# Autostart on Omarchy/Hyprland: in ~/.config/hypr/autostart.lua
#   o.launch_on_start("~/Development/evidence-mcp-dev/utilities/chrome/chrome.sh")
# Elsewhere: a user systemd service or a login item that runs this script.
#
# The DevTools port is bound to localhost by Chrome. From another machine reach
# it over the tailnet only (an SSH tunnel, or a forwarder bound to the tailnet
# IP) — never on the LAN or the internet: the port is full control of the browser.
#
# --detach        return once the port answers (terminal use); default: wait for Chrome
# The window class is fh-chrome (--class), so the compositor can keep this
# Chrome out of the way: on Hyprland (Omarchy),
#   o.window("fh-chrome", { workspace = "special:fh silent", no_initial_focus = true, focus_on_activate = false })
# — every fetch opens a tab, and without the rule each one raised the window and
# switched the desktop.
# CHROME_PROFILE  profile directory (default ~/.fh-chrome)
# CHROME_PORT     DevTools port (default 9222)
# CHROME_BIN      binary (default: google-chrome-stable, google-chrome, chromium)
set -eu
DETACH=0; [ "${1:-}" = "--detach" ] && DETACH=1
PROFILE="${CHROME_PROFILE:-$HOME/.fh-chrome}"
PORT="${CHROME_PORT:-9222}"
BIN="${CHROME_BIN:-}"
LOG="$PROFILE/chrome.sh.log"
mkdir -p "$PROFILE"
log() { echo "$(date '+%F %T') $*" | tee -a "$LOG" >&2; }
# At login the compositor may still be coming up: wait for the Wayland socket
# (and X11 for the Xwayland fallback) before launching, up to 60 s.
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  for i in $(seq 1 120); do [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/$WAYLAND_DISPLAY" ] && break; sleep 0.5; done
fi
if [ -z "$BIN" ]; then for b in google-chrome-stable google-chrome chromium; do command -v "$b" >/dev/null 2>&1 && { BIN="$b"; break; }; done; fi
[ -n "$BIN" ] || { log "chrome.sh: no Chrome found (set CHROME_BIN)"; exit 1; }
if curl -sf --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  log "chrome.sh: already listening on $PORT"
  [ "$DETACH" = 1 ] && exit 0
  # Foreground mode (a service): adopt the running Chrome — stay up while its
  # port answers, exit when it is gone so the service restarts and relaunches.
  while curl -sf --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; do sleep 5; done
  log "chrome.sh: the adopted Chrome is gone"; exit 0
fi
# Two launch attempts, Chrome's own output in the log (a crash at login shows there).
for attempt in 1 2; do
  log "chrome.sh: starting $BIN (attempt $attempt)"
  if [ "$DETACH" = 1 ]; then
    setsid -f "$BIN" --user-data-dir="$PROFILE" --remote-debugging-port="$PORT" --class=fh-chrome \
      --no-first-run --no-default-browser-check --window-size=1366,900 about:blank >>"$LOG" 2>&1
    CHROME_PID=""
  else
    "$BIN" --user-data-dir="$PROFILE" --remote-debugging-port="$PORT" --class=fh-chrome \
      --no-first-run --no-default-browser-check --window-size=1366,900 about:blank >>"$LOG" 2>&1 &
    CHROME_PID=$!
  fi
  for i in $(seq 1 120); do
    if curl -sf --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
      log "chrome.sh: $BIN listening on $PORT, profile $PROFILE"
      [ -n "$CHROME_PID" ] || exit 0
      wait "$CHROME_PID" || true
      log "chrome.sh: Chrome exited"; exit 0
    fi
    sleep 0.5
  done
  log "chrome.sh: no port $PORT after 60 s"
done
log "chrome.sh: Chrome did not open port $PORT"; exit 1
