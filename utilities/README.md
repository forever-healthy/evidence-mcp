# utilities/

What the Forever Healthy Evidence MCP needs besides the server itself and the deployment script.

| Folder / file | What |
|---|---|
| `fetch-proxy/` | An HTTP forward proxy for the fetch-proxy stage (`FH_FETCH_PROXY`): `Dockerfile` (tinyproxy on Alpine, port 8888), `tinyproxy.conf`, `compose.yaml` |
| `playwright/` | A Playwright server for the browser stages (`FH_PLAYWRIGHT_n`): `Dockerfile` (Microsoft's Playwright image at the exact `playwright-core` the package pins, `run-server` headed under Xvfb, port 8932), `compose.yaml`, `.env.example` |
| `chrome/` | A real Google Chrome for a Chrome stage (`FH_CHROME_n`): `chrome.sh`, the user service `fh-chrome.service`, `chrome-forward.sh` (the tailnet forward), `hypr-rule.sh` (Hyprland: keep Chrome off the desktop), `chrome.md` |
| `deploy.sh` | Deploys all three from the project's `.env` — below |

A project that uses these copies the folder as it is to its own top level (`<project>/utilities/`), without any `.env`; `deploy.sh` then reads that project's `.env`.

## Deployment

The browser stages are servers somebody has to run. `deploy.sh` runs them from the same `.env` the MCP server reads, so where the server connects and what gets deployed never drift apart: an `FH_PLAYWRIGHT_n` host gets a Playwright server as a Docker container, an `FH_CHROME_n` host a real Chrome as a user service — a stage configured is a stage deployed. It runs from any machine of the project.

```
utilities/deploy.sh status [host…]                     what runs, which playwright-core, reachable from here?
utilities/deploy.sh up     [host…] [--dry-run]
utilities/deploy.sh down   [host…]
```

`--dry-run` prints every command and changes nothing.

### What `up` does

For the fetch proxy `FH_FETCH_PROXY=<host>[:<port>]` (port 8888 unless given): a container `<prefix>fetch-proxy-<port>` (tinyproxy, image `<prefix>fetch-proxy:local`, 128m unless `FH_DEPLOY_FETCH_PROXY_MEM`), on that host and published like a Playwright server — 127.0.0.1 or the tailnet IP, never wider: an open proxy lends the host's IP to anyone. `status` sends a request through it. One fetch proxy only, not numbered; its settings are `FH_DEPLOY_FETCH_PROXY_USER`, `_MEM`, `_BIND`.

For each Playwright stage `FH_PLAYWRIGHT_n=<host>[:<port>]` (port 8932 unless given):

- **A container** `<prefix>playwright-server-<port>` (always with its port, so several on one host are told apart at a glance), built from `playwright/Dockerfile`, image `<prefix>playwright-server:local`, compose project `<prefix>playwright-<port>`, `restart: unless-stopped`, its memory limit from `FH_DEPLOY_PLAYWRIGHT_n_MEM` (4g).
- **On that host itself.** `127.0.0.1`, `localhost`, or this machine's own host or tailnet name use the local Docker. Any other name is reached over SSH (`DOCKER_HOST=ssh://<user>@<host>`, so Tailscale SSH or plain SSH with `~/.ssh/config`). The target needs Docker and SSH only — no checkout and no copy of the `.env`: compose sends the build folder.
- **Published on 127.0.0.1** for a loopback stage, otherwise on the host's **tailnet IP** (`tailscale ip -4`, run on that host), at `<port>`. Never on `0.0.0.0` or a LAN or public IP: a Playwright server has no authentication, and whoever reaches it drives the browser.
- The MCP server, reading the same `.env`, then reaches `ws://<host>:<port>`.

For each Chrome stage `FH_CHROME_n=<host>[:<port>]` (port 9222 unless given): `chrome/chrome.sh` and the user service `<prefix>chrome-<port>` are installed to `~/.local/share/fh-evidence/` and `~/.config/systemd/user/` of that host's user and started, with DevTools on `<port>` and Chrome's own profile `~/.<prefix>chrome-<port>`. It needs that user's desktop session. On Hyprland (Omarchy) `hypr-rule.sh` adds a window rule that parks the Chrome on a hidden workspace without focus — without it, every page Chrome opens switches the desktop to it. Chrome binds DevTools to 127.0.0.1, so a Chrome stage on another machine gets a forward onto the tailnet too: `chrome/chrome-forward.sh` as the user service `<prefix>chrome-<port>-forward` (`socat` from the tailnet IP, or `FH_DEPLOY_CHROME_n_BIND`, to 127.0.0.1).

### Versions

A Playwright server refuses a client of another `playwright-core` version (HTTP 428; the MCP log shows the alert `!! playwright <host>: Playwright version mismatch`). The image is built with the version pinned in `playwright/Dockerfile`; `status` shows each server's version and flags any mismatch, and `up` indicates it when the project's `package.json` pins a different version.

### Left to the operator

On purpose, the script does not touch these. When `status` says a stage is "not reachable from here", check them in this order:

1. **SSH:** `ssh <user>@<host> docker ps` must work without a prompt (keys, not passwords). With Tailscale SSH, a host may ask for a periodic re-check ("Tailscale SSH requires an additional check … visit https://login.tailscale.com/a/…"): open the link once, then run again.
2. **Tailscale** runs on both ends, and the hostname resolves on the tailnet.
3. **The target's firewall** lets the port in on the tailnet interface only. Every container listens inside on the port it is published on, so one ufw rule per project covers its range — this project's 9300–9399: `sudo ufw route allow in on tailscale0 proto tcp to any port 9300:9399`. A forward rule sees the container's port (Docker rewrites the destination first), which is why inside and outside are kept equal. The rule goes by interface: `ufw-docker allow <container>` would write the container's current IP and break on the next recreate.

### Settings

The shell environment wins, then the project's `.env` — `--env <file>`, else `./.env` in the folder `deploy.sh` is run from (the project's folder; the clone can sit anywhere), else the nearest `.env` above `utilities/` — then `utilities/<stage>/.env`, then the defaults. Every setting of `deploy.sh` starts with `FH_DEPLOY_`. `FH_PLAYWRIGHT_n` and `FH_CHROME_n` are the MCP server's own settings; `deploy.sh` reads them only for the hosts.

| Setting | Default | Meaning |
|---|---|---|
| `FH_DEPLOY_CONTAINER_PREFIX` | — | e.g. `evidence-`: own names for the containers, compose projects, images and Chrome services, so two projects deploy to one host side by side. Every name ends in its port (`evidence-playwright-server-9300`, `evidence-chrome-9301`), so give each project its own port range. Empty: `playwright-server-<port>`, `chrome-<port>` |
| `FH_DEPLOY_FETCH_PROXY_USER`, `_MEM`, `_BIND` | `~/.ssh/config`, `128m`, the tailnet IP | The fetch proxy's, as for a Playwright stage |
| `FH_DEPLOY_PLAYWRIGHT_n_USER` | `~/.ssh/config` | SSH user for stage n's host |
| `FH_DEPLOY_PLAYWRIGHT_n_MEM` | `4g` | Stage n's memory limit; a connected MCP server's Chromium takes about 300–400 MB, so 4g is about 6–8 at once |
| `FH_DEPLOY_PLAYWRIGHT_n_BIND` | the tailnet IP | Publish stage n on this IP instead |
| `FH_DEPLOY_CHROME_n_USER` | `~/.ssh/config` | SSH user for Chrome stage n's host |

### Example: two hosts

A data-center server next to the MCP and a machine on a residential line, whose IP clears more walls:

```bash
FH_PLAYWRIGHT_1=dc-server
FH_PLAYWRIGHT_2=home-box
FH_DEPLOY_PLAYWRIGHT_1_USER=root
FH_DEPLOY_PLAYWRIGHT_2_USER=alice
FH_DEPLOY_PLAYWRIGHT_1_MEM=6g
FH_DEPLOY_PLAYWRIGHT_2_MEM=8g
```

`utilities/deploy.sh up` from any machine in the project builds and starts `playwright-server-8932` on both, published on each one's tailnet IP at 8932.
