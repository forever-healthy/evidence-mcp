#!/bin/sh
# The Chrome stage's DevTools port onto the tailnet (#43). Chrome binds
# --remote-debugging-port to 127.0.0.1 only; this forwards <tailnet IP>:<port>
# to it, so an MCP server on another host reaches FH_CHROME_n=<this host>:<port>.
# Run by the user service <prefix>chrome-<port>-forward (utilities/deploy.sh),
# beside <prefix>chrome-<port>. Needs socat (Arch: pacman -S socat) and, on
# ufw, the port allowed in on tailscale0 — never on the LAN or the internet:
# the port is full control of the browser.
#   CHROME_PORT   the DevTools port (default 9222)
#   FORWARD_BIND  the address to listen on (default: this host's tailnet IP)
set -eu
PORT="${CHROME_PORT:-9222}"
IP="${FORWARD_BIND:-$(tailscale ip -4 2>/dev/null | head -1)}"
[ -n "$IP" ] || { echo "chrome-forward.sh: no tailnet IP (tailscale ip -4) — set FORWARD_BIND" >&2; exit 1; }
command -v socat >/dev/null 2>&1 || { echo "chrome-forward.sh: socat not installed" >&2; exit 1; }
echo "chrome-forward.sh: $IP:$PORT -> 127.0.0.1:$PORT"
exec socat "TCP-LISTEN:$PORT,bind=$IP,fork,reuseaddr" "TCP:127.0.0.1:$PORT"
