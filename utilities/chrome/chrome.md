# The real-Chrome stage

A browser stage can be a real Google Chrome instead of a Playwright server:
`FH_CHROME_n` host. The MCP server attaches over the
DevTools protocol (`chromium.connectOverCDP`) and works in the browser's own
default profile — its cookies, its GPU, its standing as a browser in daily
use. Nothing is launched by the server and nothing is saved; closing detaches.

Measured against a Playwright-server stage (2026-10-28, Omarchy VM): brand
`Google Chrome/155` instead of `Chromium`, WebGL renderer the machine's GPU
instead of SwiftShader, `navigator.webdriver` false, the host's locale and
timezone. Everything a challenge script looks at, as a desktop browser has it.

## Run it

`utilities/chrome/chrome.sh` starts Chrome with its own profile (`~/.fh-chrome`) and
the DevTools port (9222), detached, idempotent. At login it waits for the
Wayland socket first and tries twice; Chrome's own output and the script's
lines go to `~/.fh-chrome/chrome.sh.log`, the place to look when the stage
says "connect" after a reboot. On the machine that runs the
MCP server: `FH_CHROME_1=127.0.0.1` (port 9222 unless given as host:port).

Autostart as a user service (`utilities/chrome/fh-chrome.service`): `Restart=always`
brings Chrome back after a crash or a self-update, and the service adopts a
Chrome already running on the port:

    mkdir -p ~/.config/systemd/user && cp utilities/chrome/fh-chrome.service ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now fh-chrome

Not as a Hyprland `exec`/`launch_on_start`: Chrome launched in that transient
scope died 7–14 s after start on every try (2026-10-28), for reasons that did
not show in any log; under a service or from a shell it runs on.

## Remote stage (tailnet)

A stage on another machine than the MCP server (`FH_CHROME_n=<host>:<port>`):
Chrome binds its DevTools port to 127.0.0.1, so it has to be forwarded onto the
tailnet — never to the LAN or the internet: the port is full control of the
browser. `utilities/deploy.sh up` does all of it for every `FH_CHROME_n`:

1. `chrome.sh` as the user service `<prefix>chrome-<port>`, profile
   `~/.<prefix>chrome-<port>` — each project its own browser and profile
2. `chrome-forward.sh` as `<prefix>chrome-<port>-forward`: `socat` from
   `<tailnet IP>:<port>` to `127.0.0.1:<port>` (needs `socat`;
   `FH_DEPLOY_CHROME_n_BIND` for another address)
3. the firewall, by hand: on ufw `sudo ufw allow in on tailscale0 proto tcp to
   any port <port>` (or the project's range) — a host service, so an input
   rule, not the route rule of the containers
4. check from the server's host: `utilities/deploy.sh status`, or
   `curl -s http://<tailnet IP>:<port>/json/version`

Chrome answers only a Host header that is an IP address or localhost, so
`curl http://<name>:<port>/…` gets "Host header is specified and is not an IP
address or localhost"; the MCP server resolves the name itself and connects by
address. On an ARM64 Linux machine there is no Google Chrome: `chrome.sh` takes
Chromium — the brand differs, the GPU, profile and standing are the same.

## Keep it out of the way

Every fetch opens a tab, and Chrome raises its window for each — on a desktop
that switches the active workspace all day. The Chrome runs with the window
class `fh-chrome` (`--class`), so one compositor rule parks it. On Hyprland
(Omarchy) `utilities/deploy.sh up` adds it: `hypr-rule.sh` appends once to
`~/.config/hypr/hyprland.lua` (a backup next to it), before Chrome restarts:

    o.window("^fh-chrome$", { workspace = "special:fh-chrome silent", focus_on_activate = false, no_initial_focus = true })

A Chrome started by hand, or before the rule: run `hypr-rule.sh`, then restart
the service (`systemctl --user restart <prefix>chrome-<port>`) — a rule applies
to windows opened after it. With the older `hyprland.conf` the script only
prints a hint. The stage keeps rendering on the hidden workspace (it is headed,
which is what clears the walls); `hyprctl clients` lists its windows there.

## What to expect

- One Chrome, shared by every worker that uses the stage: concurrent fetches
  open tabs side by side in it; each tab is closed after its fetch.
- PDFs: Chrome's viewer renders them in the tab; the server then fetches the
  bytes with the tab's cookies (log: `ok browser chrome@host`).
- Chrome updates and restarts itself; `chrome.sh` brings it back at the next
  login. While it is down the stage fails with "connect" and the download moves on to the next stage.
- The profile is yours to look at: open `chrome://version` in it for the path.
