#!/usr/bin/env bash
# utilities/deploy.sh — start the browser stages a project's configuration names,
# on this machine or remotely, from one place.
# Agents: read utilities/README.md before deploying — what gets deployed, the
# settings, SSH and firewall prerequisites, and what to check when a stage is
# not reachable. Then run up, then status.
#
#   utilities/deploy.sh up     [host…]   build and (re)start them
#   utilities/deploy.sh down   [host…]   stop and remove them
#   utilities/deploy.sh status [host…]   per stage: running, playwright-core version, reachable
#   --env <file>                         the project's .env (default: ./.env, else the nearest above utilities/)
#   --dry-run                            print what would run, change nothing
#
# What to deploy is what the MCP server connects to, stage by stage — a stage
# configured is a stage deployed:
#   FH_FETCH_PROXY          an HTTP proxy (container <prefix>fetch-proxy-<port>, tinyproxy)
#                           on that host
#   FH_PLAYWRIGHT_1, _2, …  a Playwright server (container <prefix>playwright-server-<port>) on that host
#   FH_CHROME_1, _2, …      a real Google Chrome (user service <prefix>chrome-<port>) on that host
# Not configured, not deployed: there is no deploy flag. A value is a host, or host:port (default 8888 / 8932 / 9222).
#   127.0.0.1, localhost, this machine's host or tailnet name → this machine's Docker
#   any other host → over SSH (DOCKER_HOST=ssh://…; Tailscale SSH or plain ssh,
#   ~/.ssh/config decides user and key). The target needs Docker and SSH, no checkout:
#   compose sends the build folder.
# Published on 127.0.0.1 for a loopback stage, else on the host's tailnet IP
# (`tailscale ip -4` there) — never 0.0.0.0: the servers have no auth.
#
# Settings, first match wins: the shell environment; the project's .env (--env <file>,
# else FH_DEPLOY_ENV, else ./.env where the script is run from — the project's folder,
# the clone may sit anywhere — else the nearest .env above this folder); utilities/<stage>/.env;
# the defaults.
#   FH_DEPLOY_CONTAINER_PREFIX=evidence-
#                                      names of containers, compose projects, images and Chrome
#                                      services, so two projects deploy to one host side by side
#                                      (default: none). Every name ends in its port —
#                                      evidence-playwright-server-9300, evidence-chrome-9301 —
#                                      so give each project its own port range
# Per stage, numbered like the stage (FH_PLAYWRIGHT_1 → FH_DEPLOY_PLAYWRIGHT_1_…):
#   FH_DEPLOY_PLAYWRIGHT_1_USER=root   SSH user for that stage's host (else ~/.ssh/config)
#   FH_DEPLOY_PLAYWRIGHT_1_MEM=6g      its memory limit (else 4g)
#   FH_DEPLOY_PLAYWRIGHT_1_BIND=<ip>   publish on this IP instead of the tailnet IP
#   FH_DEPLOY_CHROME_1_USER=mig        likewise for a Chrome stage
#   FH_DEPLOY_FETCH_PROXY_USER, _MEM (else 128m), _BIND   likewise for the fetch proxy (one, not numbered)
# Every setting of this script starts with FH_DEPLOY_; FH_FETCH_PROXY,
# FH_PLAYWRIGHT_n and FH_CHROME_n are the MCP server's own, read here only for the hosts.
#
# Not done here: the firewall. A tailnet-published port must be open on
# tailscale0. Every container listens inside on the port it is published on, so
# one ufw rule per project covers its range (the project's ports, e.g. 9300:9399):
# `sudo ufw route allow in on tailscale0 proto tcp to any port <from>:<to>`
# (a forward rule sees the container's port, after Docker's DNAT; by interface; `ufw-docker allow <container>` writes the container's IP and
# breaks on the next recreate). status says when a port does not answer.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ACTION="${1:-}"; [ $# -gt 0 ] && shift
DRY=0; ONLY=(); ENV_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --env) shift; ENV_ARG="${1:-}"; [ -f "$ENV_ARG" ] || { echo "--env: no such file: $ENV_ARG" >&2; exit 2; } ;;
    --env=*) ENV_ARG="${1#--env=}"; [ -f "$ENV_ARG" ] || { echo "--env: no such file: $ENV_ARG" >&2; exit 2; } ;;
    *) ONLY+=("$1") ;;
  esac
  shift
done
case "$ACTION" in up|down|status) ;; *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac

# ---- settings ------------------------------------------------------------
# The project's .env: --env, else FH_DEPLOY_ENV, else ./.env (run from the project's
# folder, the clone elsewhere), else the nearest .env above utilities/.
project_env() {
  [ -n "$ENV_ARG" ] && { (cd "$(dirname "$ENV_ARG")" && echo "$PWD/$(basename "$ENV_ARG")"); return; }
  [ -n "${FH_DEPLOY_ENV:-}" ] && { echo "$FH_DEPLOY_ENV"; return; }
  [ -f "$PWD/.env" ] && { echo "$PWD/.env"; return; }
  local d; d="$(dirname "$HERE")"
  while [ "$d" != "/" ]; do
    [ -f "$d/.env" ] && { echo "$d/.env"; return; }
    [ -e "$d/.git" ] && return          # the project's root reached without one
    d="$(dirname "$d")"
  done
}
ENV_FILES=()
pe="$(project_env)"; [ -n "$pe" ] && ENV_FILES+=("$pe")
for f in "$HERE/fetch-proxy/.env" "$HERE/playwright/.env" "$HERE/chrome/.env"; do [ -f "$f" ] && ENV_FILES+=("$f"); done

# KEY's value: environment, else the first file that sets it (an inline "# …" dropped).
get() {
  local k="$1" v
  if [ -n "${!k+x}" ]; then echo "${!k}"; return; fi
  for f in "${ENV_FILES[@]}"; do
    v="$(grep -E "^[[:space:]]*$k=" "$f" 2>/dev/null | tail -1 | sed -E "s/^[^=]*=//; s/[[:space:]]+#.*$//; s/^[\"']//; s/[\"'][[:space:]]*$//; s/[[:space:]]+$//")" || true
    [ -n "$v" ] && { echo "$v"; return; }
  done
  echo "${2:-}"
}
# The stages of one kind, in order: "key host port" per line (key: FH_PLAYWRIGHT_1 …).
stages() {
  local prefix="$1" port="$2" n v
  for n in $(seq 1 20); do
    v="$(get "${prefix}_$n")"; [ -z "$v" ] && continue
    case "$v" in *:*) echo "${prefix}_$n ${v%%:*} ${v##*:}" ;; *) echo "${prefix}_$n $v $port" ;; esac
  done
}

SELF="$(hostname -s 2>/dev/null || hostname)"
TS_SELF="$(tailscale status --self --json 2>/dev/null | sed -n 's/.*"HostName": *"\([^"]*\)".*/\1/p' | head -1 || true)"
is_loopback() { [ "$1" = "127.0.0.1" ] || [ "$1" = "localhost" ]; }
is_local() { is_loopback "$1" || [ "$1" = "$SELF" ] || [ "$1" = "$(hostname)" ] || { [ -n "$TS_SELF" ] && [ "$1" = "$TS_SELF" ]; }; }
wanted() { [ ${#ONLY[@]} -eq 0 ] && return 0; local o; for o in "${ONLY[@]}"; do [ "$o" = "$1" ] && return 0; done; return 1; }
RK=""   # the stage being deployed (FH_FETCH_PROXY, FH_PLAYWRIGHT_1 …); its settings are FH_DEPLOY_PLAYWRIGHT_1_USER, _MEM, _BIND
rk() { echo "FH_DEPLOY_${RK#FH_}_$1"; }   # rk USER → FH_DEPLOY_PLAYWRIGHT_1_USER
per_stage() { get "$(rk "$1")" "${2:-}"; }   # per_stage SUFFIX [default]
target() { local u; u="$(per_stage USER)"; echo "${u:+$u@}$1"; }

run() { if [ $DRY -eq 1 ]; then printf '  would run:'; printf ' %q' "$@"; echo; else "$@"; fi; }
on() {   # on <host> <command…>: here, or over ssh
  local h="$1"; shift
  if is_local "$h"; then run "$@"; else run ssh -n -o BatchMode=yes "$(target "$h")" "$(printf '%q ' "$@")"; fi
}
docker_on() {   # docker on that host's daemon
  local h="$1"; shift
  if is_local "$h"; then run docker "$@"; else run env DOCKER_HOST="ssh://$(target "$h")" docker "$@"; fi
}
bind_ip() {
  local h="$1" k ip
  ip="$(get "$(rk BIND)")"
  [ -n "$ip" ] && { echo "$ip"; return; }
  is_loopback "$h" && { echo 127.0.0.1; return; }
  if is_local "$h"; then ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  else ip="$(ssh -n -o BatchMode=yes "$(target "$h")" tailscale ip -4 2>/dev/null | head -1 || true)"; fi
  [ -n "$ip" ] || { echo "deploy: no tailnet IP for $h — set $(rk BIND)" >&2; return 1; }
  echo "$ip"
}
PINNED="$(sed -n 's/.*playwright-core@\([0-9.]*\).*/\1/p' "$HERE/playwright/Dockerfile" | head -1)"

# A Playwright server refuses a client of another playwright-core (428). When
# the project's package.json pins another one than the image, up says so.
pin_note() {
  local pj v; pj="$(dirname "$HERE")/package.json"; [ -f "$pj" ] || return 0
  v="$(node -p '((require(process.argv[1]).dependencies||{})["playwright-core"]||"").replace(/^[~^]/,"")' "$pj" 2>/dev/null || true)"
  [ -n "$v" ] && [ "$v" != "$PINNED" ] && echo "note: package.json pins playwright-core $v, the image $PINNED — clients of $v will be refused" >&2
  return 0
}

# ---- fetch proxies --------------------------------------------------------
fetch_proxy() {
  local h="$1" port="$2" name ip envf
  local pre; pre="$(get FH_DEPLOY_CONTAINER_PREFIX)"
  name="${pre}fetch-proxy-$port"
  case "$ACTION" in
    up)
      ip="$(bind_ip "$h")" || return 1
      envf="$(mktemp)"; trap 'rm -f "$envf"' RETURN
      printf 'BIND_IP=%s\nPORT=%s\nMEM_LIMIT=%s\nCONTAINER=%s\nIMAGE=%s\n' "$ip" "$port" "$(per_stage MEM 128m)" "$name" "${pre}fetch-proxy:local" > "$envf"
      echo "fetch-proxy $h: $name on $ip:$port$(is_local "$h" || echo " via $(target "$h")")"
      ( unset BIND_IP PORT MEM_LIMIT CONTAINER IMAGE
        docker_on "$h" compose -p "$name" --env-file "$envf" -f "$HERE/fetch-proxy/compose.yaml" up -d --build --remove-orphans ) ;;
    down)
      echo "fetch-proxy $h: stopping $name"
      docker_on "$h" compose -p "$name" -f "$HERE/fetch-proxy/compose.yaml" down ;;
    status)
      local st code
      st="$(docker_on "$h" ps --filter "name=^${name}\$" --format '{{.Status}}' 2>/dev/null || true)"
      code="$(curl -s -m10 -o /dev/null -w '%{http_code}' -x "http://$h:$port" https://www.example.org/ 2>/dev/null || true)"
      printf 'fetch-proxy %-15s %-26s %-22s %s\n' "$h:$port" "${st:-not running}" "" \
        "$([ "$code" = 200 ] && echo "reachable, proxies" || echo "not reachable from here (HTTP ${code:-none}) — firewall? on $h: sudo ufw route allow in on tailscale0 proto tcp to any port $port")" ;;
  esac
}

# ---- Playwright servers ---------------------------------------------------
playwright() {
  local h="$1" port="$2" name proj ip envf
  local pre; pre="$(get FH_DEPLOY_CONTAINER_PREFIX)"
  name="${pre}playwright-server-$port"; proj="${pre}playwright-$port"
  case "$ACTION" in
    up)
      ip="$(bind_ip "$h")" || return 1
      envf="$(mktemp)"; trap 'rm -f "$envf"' RETURN
      printf 'BIND_IP=%s\nPORT=%s\nMEM_LIMIT=%s\nCONTAINER=%s\nIMAGE=%s\n' "$ip" "$port" "$(per_stage MEM 4g)" "$name" "${pre}playwright-server:local" > "$envf"
      echo "playwright $h: $name on $ip:$port, $(per_stage MEM 4g) (playwright-core $PINNED)$(is_local "$h" || echo " via $(target "$h")")"
      ( unset BIND_IP PORT MEM_LIMIT CONTAINER IMAGE
        docker_on "$h" compose -p "$proj" --env-file "$envf" -f "$HERE/playwright/compose.yaml" up -d --build --remove-orphans ) ;;
    down)
      echo "playwright $h: stopping $name"
      docker_on "$h" compose -p "$proj" -f "$HERE/playwright/compose.yaml" down ;;
    status)
      local st ver code
      st="$(docker_on "$h" ps --filter "name=^${name}\$" --format '{{.Status}}' 2>/dev/null || true)"
      ver="$(docker_on "$h" exec "$name" playwright-core --version 2>/dev/null | sed -n 's/.*Version \([0-9.]*\).*/\1/p' || true)"
      code="$(curl -s -m8 -o /dev/null -w '%{http_code}' "http://$h:$port/" 2>/dev/null || true)"
      printf 'playwright %-16s %-26s %-22s %s\n' "$h:$port" "${st:-not running}" \
        "core ${ver:-?}$([ -n "$ver" ] && [ "$ver" != "$PINNED" ] && echo " ≠ $PINNED")" \
        "$([ "$code" = 200 ] && echo reachable || echo "not reachable from here (HTTP ${code:-none}) — firewall? on $h: sudo ufw route allow in on tailscale0 proto tcp to any port $port")" ;;
  esac
}

# ---- Chrome stages ---------------------------------------------------------
# Installed to ~/.local/share/fh-evidence/ on the host, run by the user service
# <prefix>chrome-<port> (Restart=always) with the profile ~/.<prefix>chrome-<port>.
# It needs that user's desktop session.
chrome() {
  local h="$1" port="$2" dest=".local/share/fh-evidence" unit svc bind
  svc="$(get FH_DEPLOY_CONTAINER_PREFIX)chrome-$port"
  bind="$(get "$(rk BIND)")"   # FH_DEPLOY_CHROME_n_BIND: the forward's address instead of the tailnet IP
  case "$ACTION" in
    up)
      echo "chrome $h: $svc on :$port"
      unit="$(mktemp)"; trap 'rm -f "$unit"' RETURN
      sed -e "s#^ExecStart=.*#ExecStart=%h/$dest/chrome.sh#" "$HERE/chrome/fh-chrome.service" \
        | awk -v p="$port" -v s="$svc" '{print} /^\[Service\]/{print "Environment=CHROME_PORT=" p " CHROME_PROFILE=%h/." s}' > "$unit"
      if is_local "$h"; then
        run mkdir -p "$HOME/$dest" "$HOME/.config/systemd/user"
        run install -m 755 "$HERE/chrome/chrome.sh" "$HOME/$dest/chrome.sh"
        run install -m 755 "$HERE/chrome/hypr-rule.sh" "$HOME/$dest/hypr-rule.sh"
        run install -m 644 "$unit" "$HOME/.config/systemd/user/$svc.service"
      else
        on "$h" mkdir -p "$dest" .config/systemd/user
        run scp -q "$HERE/chrome/chrome.sh" "$(target "$h"):$dest/chrome.sh"
        run scp -q "$HERE/chrome/hypr-rule.sh" "$(target "$h"):$dest/hypr-rule.sh"
        run scp -q "$unit" "$(target "$h"):.config/systemd/user/$svc.service"
      fi
      # Not on 127.0.0.1: Chrome binds DevTools to 127.0.0.1 there, so a second
      # service, <svc>-forward, puts the port on the host's tailnet IP (socat, #43).
      if ! is_loopback "$h"; then
        local fwd; fwd="$(mktemp)"
        printf '%s\n' "[Unit]" "Description=evidence-mcp: $svc's DevTools port on the tailnet" "After=$svc.service" "PartOf=$svc.service" "" \
          "[Service]" "Type=simple" "Environment=CHROME_PORT=$port${bind:+ FORWARD_BIND=$bind}" "ExecStart=%h/$dest/chrome-forward.sh" "Restart=always" "RestartSec=5" "" \
          "[Install]" "WantedBy=$svc.service" > "$fwd"
        if is_local "$h"; then
          run install -m 755 "$HERE/chrome/chrome-forward.sh" "$HOME/$dest/chrome-forward.sh"
          run install -m 644 "$fwd" "$HOME/.config/systemd/user/$svc-forward.service"
        else
          run scp -q "$HERE/chrome/chrome-forward.sh" "$(target "$h"):$dest/chrome-forward.sh"
          run scp -q "$fwd" "$(target "$h"):.config/systemd/user/$svc-forward.service"
        fi
        rm -f "$fwd"
      fi
      # On Hyprland, a window rule keeps Chrome from switching the desktop to it on every page (before the restart, so its windows get it).
      if is_local "$h"; then run "$HOME/$dest/hypr-rule.sh"; else on "$h" "$dest/hypr-rule.sh"; fi
      on "$h" systemctl --user daemon-reload
      on "$h" systemctl --user enable --now "$svc"
      on "$h" systemctl --user restart "$svc"
      if ! is_loopback "$h"; then
        on "$h" systemctl --user enable --now "$svc-forward"
        on "$h" systemctl --user restart "$svc-forward"
        echo "chrome $h: $svc-forward puts :$port on the tailnet; on ufw allow it in on tailscale0: sudo ufw allow in on tailscale0 proto tcp to any port $port"
      fi ;;
    down)
      echo "chrome $h: stopping $svc"
      is_loopback "$h" || on "$h" systemctl --user disable --now "$svc-forward" || true
      on "$h" systemctl --user disable --now "$svc" ;;
    status)
      local st fw code
      st="$(on "$h" systemctl --user is-active "$svc" 2>/dev/null || true)"
      is_loopback "$h" || fw="$(on "$h" systemctl --user is-active "$svc-forward" 2>/dev/null || true)"
      # Host: localhost — Chrome answers only a Host header that is an IP address or localhost, not the stage's name.
      code="$(curl -s -m8 -o /dev/null -w '%{http_code}' -H "Host: localhost" "http://$h:$port/json/version" 2>/dev/null || true)"
      printf 'chrome     %-16s %-26s %-22s %s\n' "$h:$port" "${st:-unknown}" "$(is_loopback "$h" || echo "forward ${fw:-unknown}")" \
        "$([ "$code" = 200 ] && echo reachable || echo "not reachable from here (HTTP ${code:-none}) — firewall? on $h: sudo ufw allow in on tailscale0 proto tcp to any port $port")" ;;
  esac
}

# ---- run ------------------------------------------------------------------
echo "settings: ${ENV_FILES[*]:-defaults only}"
[ "$ACTION" = up ] && pin_note
found=0 failed=0
# The lists are read on fd 3: ssh, docker and scp inside must not eat them.
while read -r RK h p <&3; do
  [ -z "$h" ] && continue; found=1
  wanted "$h" || continue
  fetch_proxy "$h" "$p" </dev/null || { echo "fetch-proxy $h: failed" >&2; failed=1; }
done 3< <(v="$(get FH_FETCH_PROXY)"; [ -z "$v" ] || case "$v" in *:*) echo "FH_FETCH_PROXY ${v%%:*} ${v##*:}" ;; *) echo "FH_FETCH_PROXY $v 8888" ;; esac)
while read -r RK h p <&3; do
  [ -z "$h" ] && continue; found=1
  wanted "$h" || continue
  playwright "$h" "$p" </dev/null || { echo "playwright $h: failed" >&2; failed=1; }
done 3< <(stages FH_PLAYWRIGHT 8932)
while read -r RK h p <&3; do
  [ -z "$h" ] && continue; found=1
  wanted "$h" || continue
  chrome "$h" "$p" </dev/null || { echo "chrome $h: failed" >&2; failed=1; }
done 3< <(stages FH_CHROME 9222)
[ $found -eq 1 ] || echo "nothing to deploy: no FH_FETCH_PROXY, FH_PLAYWRIGHT_n or FH_CHROME_n in ${ENV_FILES[*]:-the environment}"
# A stage that failed fails the run (2026-11-13: an image build that could not resolve
# registry.npmjs.org ended with exit 0).
exit $failed
