// Browser stages of the download: Chromium driven by Playwright.
// Plain fetch → browser(s) → unlocker, the same multi-stage fetch AI4L use for URL
// verification (d-browser → d-proxy-1 → d-proxy-2). Sites behind a JavaScript
// challenge (Cloudflare's "Just a moment…") answer a script with 403 and a
// headed browser with the page. The browser presents itself as Chromium sets
// it up (navigator.webdriver stays true); a site that blocks on that is
// recorded as "challenge not cleared".
//
// The browser stages of the download, two kinds, each its own family of
// variables (environment), hostnames only — the kind is in the name, the
// protocol and the default port are ours:
//   FH_PLAYWRIGHT_1, _2 …  a Playwright server (`playwright run-server`,
//                                  ws://host:8932; host or host:port). utilities/playwright/
//                                  in the repo has the container: Microsoft's
//                                  Playwright image, headed under Xvfb, at the
//                                  exact playwright-core version this package
//                                  pins (a server of another version refuses the
//                                  client, 428). Typically one next to the MCP
//                                  server (data-centre IP), one on a residential
//                                  line.
//   FH_CHROME_1, _2 …      a real Google Chrome with --remote-debugging-port
//                                  (host or host:port, default 9222), attached over
//                                  the DevTools protocol: its own profile, GPU and
//                                  standing (utilities/chrome/chrome.md); the strongest
//                                  stage, on a desktop machine.
// Order: the Playwright servers in index order, then the Chrome stages in index
// order; an unset number is skipped, so a deployment fills what it has.
//   FH_PLAYWRIGHT_HEADLESS    auto | true | false, for the Playwright stages:
//                                  auto = headed (that is what the server's Xvfb
//                                  is for; headed passes challenges that headless
//                                  does not). A Chrome stage is whatever it is.
// No browser is bundled with the package, none is downloaded and none is
// launched here: every stage is a browser somebody runs. A Playwright stage keeps
// its cookies in <library>/.browser/<label>.json between runs.
import { isIP } from "node:net";
import { hostState } from "./hosts.js";
import { PLAIN_HTTP, toHttps } from "./http.js";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Download } from "playwright-core";
import { str } from "./env.js";
import { FH_EVIDENCE_DIR } from "./layout.js";

export type BrowserConfig = { browsers: string[]; headless: "auto" | boolean };   // browsers: the stages as internal endpoints, ws://host:port then cdp://host:port

const PLAYWRIGHT_PORT = 8932, CHROME_PORT = 9222;
// "host" or "host:port"; a scheme or a trailing slash somebody typed is dropped.
export function hostPort(value: string, defaultPort: number): { host: string; port: number } | null {
  const v = value.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
}

export function browserConfig(env: NodeJS.ProcessEnv = process.env): BrowserConfig {
  const out: BrowserConfig = { browsers: [], headless: "auto" };
  const add = (endpoint: string) => { if (!out.browsers.includes(endpoint)) out.browsers.push(endpoint); };
  for (let i = 1; i <= 9; i++) {
    const hp = hostPort(str(`FH_PLAYWRIGHT_${i}`, env), PLAYWRIGHT_PORT);
    if (hp) add(`ws://${hp.host}:${hp.port}`);
  }
  for (let i = 1; i <= 9; i++) {
    const hp = hostPort(str(`FH_CHROME_${i}`, env), CHROME_PORT);
    if (hp) add(`cdp://${hp.host}:${hp.port}`);
  }
  const h = str("FH_PLAYWRIGHT_HEADLESS", env).toLowerCase();
  if (h === "true" || h === "false") out.headless = h === "true";
  return out;
}

// The Playwright version this package pins (package.json, exact). A Playwright
// server (utilities/playwright/Dockerfile) refuses a client of any other version with
// "428 Precondition Required"; fh_info and the TUI's /status show the
// number an operator has to match, and the log says so in words (#19).
export const PLAYWRIGHT_VERSION: string = (() => { try { return createRequire(import.meta.url)("playwright-core/package.json").version as string; } catch { return "unknown"; } })();
export const MISMATCH = "Playwright version mismatch";
export function connectError(e: unknown, endpoint: string): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b428\b/.test(msg) ? new Error(`${MISMATCH} — server ${endpoint} must run playwright-core ${PLAYWRIGHT_VERSION}`) : e instanceof Error ? e : new Error(msg);
}
export const isRemote = (endpoint: string) => /^wss?:\/\//i.test(endpoint);
export const isCdp = (endpoint: string) => /^cdp:\/\//i.test(endpoint);
const cdpHttp = (endpoint: string) => endpoint.replace(/^cdp:\/\//i, "http://");
// Chrome answers its DevTools port only for a Host header that is an IP address
// or localhost ("Host header is specified and is not an IP address or
// localhost" — DNS-rebinding protection), so a stage named by host (home-box,
// over its tailnet forward) is connected to by its address. The name stays the
// stage's label in the log and the wall memory.
export async function cdpUrl(endpoint: string): Promise<string> {
  const u = new URL(cdpHttp(endpoint));
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) return u.toString().replace(/\/$/, "");
  // The address the health check found accepting (src/hosts.ts): not simply the first a lookup
  // gives, which can be a link-local IPv6 without its zone.
  const h = await hostState(host, Number(u.port) || 9222);
  if (h.address) u.hostname = isIP(h.address) === 6 ? `[${h.address}]` : h.address;
  return u.toString().replace(/\/$/, "");
}
export type StageKind = "playwright" | "chrome";
export const stageKind = (endpoint: string): StageKind => isCdp(endpoint) ? "chrome" : "playwright";
// A stage's name in the log, in failure reasons and in the wall memory: its kind and label ("playwright dc-server", "chrome desktop").
// "browser <label>" is the name before 0.2.24: still recognised in stored reasons and walls.
export const stageName = (b: { kind: StageKind; label: string }) => `${b.kind} ${b.label}`;
export const STAGE_PREFIX = /^(?:playwright|chrome|browser|fetch-proxy) [^:]+: /;

export type BrowserStage = { kind: StageKind; host: string; port: number; label: string; endpoint: string; headless: boolean };

const hostOf = (endpoint: string) => { try { return new URL(isCdp(endpoint) ? cdpHttp(endpoint) : endpoint); } catch { return null; } };
// Short name for log lines and attempts: the stage's host. The kind comes from
// stageName ("playwright home-box", "chrome home-box"); "chrome@host" until
// 0.2.32 made it "chrome chrome@home-box".
export function browserLabel(endpoint: string): string {
  const u = hostOf(endpoint); if (!u) return endpoint;
  return u.hostname;
}

export function browserHeadless(endpoint: string, cfg = browserConfig()): boolean {
  if (isCdp(endpoint)) return false;   // whatever the attached Chrome is, which is headed
  return cfg.headless === "auto" ? false : cfg.headless;   // a Playwright server runs headed: that is what its Xvfb is for
}

// The stages as configured: the Playwright servers, then the Chrome stages.
// Whether a stage answers shows up per attempt, in the log.
export function browserStages(cfg = browserConfig()): BrowserStage[] {
  return cfg.browsers.map((endpoint) => {
    const u = hostOf(endpoint);
    return { kind: stageKind(endpoint), host: u?.hostname ?? endpoint, port: Number(u?.port) || (isCdp(endpoint) ? CHROME_PORT : PLAYWRIGHT_PORT), label: browserLabel(endpoint), endpoint, headless: browserHeadless(endpoint, cfg) };
  });
}

export type Browsed = { bytes: Buffer; contentType: string; url: string; via: "download" | "page" | "request" | "response" };

const CHALLENGE = /just a moment|nur einen moment|attention required|verify you are human|human verification|checking your browser|access denied/i;
const CONNECT_TIMEOUT_MS = 20_000, NAV_TIMEOUT_MS = 20_000, CHALLENGE_WAIT_MS = 8_000, DOWNLOAD_WAIT_MS = 10_000, IDLE_CLOSE_MS = 120_000;
// A script-rendered page: domcontentloaded comes with a shell ("Loading…", an
// empty root div) that the page's own scripts fill in afterwards. When the
// visible text is that short, wait for the network to go quiet and the text to
// grow, at most SETTLE_MS; a page with text already is read at once.
const SETTLE_MS = 8_000, SETTLE_WORDS = 100;

const ctxs = new Map<string, Promise<{ ctx: BrowserContext; browser: Browser | null }>>();
let idleTimer: NodeJS.Timeout | null = null;

// A regular desktop Chrome, as far as launch options go: no automation
// banner/flag (navigator.webdriver false), a normal window on a larger screen
// (the container's Xvfb is 1920x1080), the operator's locale and timezone, and
// cookies kept per stage between runs (<library>/.browser/<label>.json) — a
// challenge once cleared stays cleared, like in a browser that is used daily.
const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled", "--window-size=1366,900"];
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin";
const CONTEXT_OPTS = { acceptDownloads: true, viewport: null as null, locale: "en-US", timezoneId: TIMEZONE };

function stateFile(endpoint: string): string {
  const dir = join(FH_EVIDENCE_DIR, ".browser"); mkdirSync(dir, { recursive: true });
  return join(dir, `${browserLabel(endpoint).replace(/[^A-Za-z0-9.-]+/g, "_")}.json`);
}

async function context(endpoint: string, cfg: BrowserConfig): Promise<BrowserContext> {
  let p = ctxs.get(endpoint);
  if (!p) {
    p = (async () => {
      const headless = browserHeadless(endpoint, cfg);
      const drop = () => { if (ctxs.get(endpoint) === p) ctxs.delete(endpoint); };
      if (isCdp(endpoint)) {
        // A real Chrome: attach, and work in ITS default context — the profile
        // with the cookies and the standing a browser in daily use has. Nothing
        // is launched and nothing is saved; closing only detaches.
        const browser = await chromium.connectOverCDP(await cdpUrl(endpoint), { timeout: CONNECT_TIMEOUT_MS });
        browser.on("disconnected", drop);
        const ctx = browser.contexts()[0] ?? await browser.newContext(CONTEXT_OPTS);
        return { ctx, browser };
      }
      if (isRemote(endpoint)) {
        // The server launches a browser per connection with the options we send.
        const browser = await chromium.connect(endpoint, {
          timeout: CONNECT_TIMEOUT_MS,
          headers: { "x-playwright-launch-options": JSON.stringify({ headless, args: LAUNCH_ARGS, ignoreDefaultArgs: ["--enable-automation"] }) },
        }).catch((e: unknown) => { throw connectError(e, endpoint); });
        browser.on("disconnected", drop);
        const state = stateFile(endpoint);
        const ctx = await browser.newContext({ ...CONTEXT_OPTS, ...(existsSync(state) ? { storageState: state } : {}) });
        return { ctx, browser };
      }
      throw new Error(`not a browser stage: ${endpoint}`);
    })();
    ctxs.set(endpoint, p);
    p.catch(() => { if (ctxs.get(endpoint) === p) ctxs.delete(endpoint); });
  }
  return (await p).ctx;
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { void closeBrowsers(); }, IDLE_CLOSE_MS);
  idleTimer.unref();
}

export async function closeBrowsers(): Promise<void> {
  const open = [...ctxs.entries()]; ctxs.clear();
  for (const [endpoint, p] of open) {
    try {
      const { ctx, browser } = await p;
      if (isCdp(endpoint)) { await browser?.close().catch(() => undefined); continue; }   // detach only; the Chrome and its tabs stay
      if (browser) await ctx.storageState({ path: stateFile(endpoint) }).catch(() => undefined);   // cookies for the next run
      await ctx.close().catch(() => undefined); await browser?.close().catch(() => undefined);
    } catch { /* already gone */ }
  }
}

// Fetch one URL through the browser at `endpoint`. A PDF arrives as a download
// (bytes + application/pdf) or, when the browser rendered it instead (remote
// contexts have no profile preference), is re-requested with the context's
// cookies — the cleared challenge included. Anything else is the rendered
// page's HTML after the challenge, if any, has cleared. Throws on navigation
// failure, a challenge that never clears ("challenge not cleared"), HTTP ≥ 400.
// Timeouts are short on purpose: in the logs every successful browser fetch
// finished within 10 s; a challenge still showing after 8 s never cleared.
export async function browserFetch(url: string, endpoint: string, cfg = browserConfig(), signal?: AbortSignal): Promise<Browsed> {
  url = toHttps(url);   // HTTPS only (src/http.ts)
  const ctx = await context(endpoint, cfg);
  touchIdle();
  const page = await ctx.newPage();
  // Cancelled (another request of the stage decided it, src/race.ts): the tab is closed, every wait on it fails.
  const onAbort = () => { page.close().catch(() => undefined); };
  if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // A PDF that Chrome renders in its viewer (a real Chrome over CDP, or a
    // signed single-use link): the bytes are read from the network responses —
    // the viewer first probes the file (a few hundred bytes), then loads it in
    // full, under a chrome-extension:// URL; the largest body that starts with
    // %PDF- is the document. Re-requesting the URL may not be allowed.
    let pdfBest: Buffer | null = null; const pdfReads: Promise<void>[] = [];
    let status: number | undefined, contentType = "";
    page.on("response", (r) => {
      // The status and type of the LAST main-frame navigation: a Cloudflare
      // challenge answers 403 first and reloads the page once cleared.
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) { status = r.status(); contentType = r.headers()["content-type"] ?? ""; }
      if (r.status() !== 200 || !/application\/pdf/i.test(r.headers()["content-type"] ?? "")) return;
      pdfReads.push(r.body().then((b) => { if (b.subarray(0, 5).toString("latin1") === "%PDF-" && (!pdfBest || b.length > pdfBest.length)) pdfBest = b; }).catch(() => undefined));
    });
    let download: Download | null = null;
    const dl = page.waitForEvent("download", { timeout: NAV_TIMEOUT_MS + CHALLENGE_WAIT_MS + DOWNLOAD_WAIT_MS }).then((d) => { download = d; return d; }).catch(() => null);
    let navError: string | null = null;
    // goto and a download race: a PDF turns the navigation into a download and
    // domcontentloaded never fires, so goto alone would time out.
    const nav = page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
      .then((resp) => { if (status === undefined) { status = resp?.status(); contentType = resp?.headers()["content-type"] ?? ""; } })
      .catch((e) => { navError = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 80); });
    await Promise.race([nav, dl]);
    const pause = (ms: number) => Promise.race([dl, new Promise((r) => setTimeout(r, ms))]);
    if (download) { /* arrived during navigation */ }
    else if (navError && !/download is starting|net::ERR_ABORTED/i.test(navError)) {
      await pause(2000);
      if (!download) throw new Error(`navigation: ${navError}`);
    } else {
      await pause(2000);   // give a download a moment, then wait out a challenge page
      const t0 = Date.now();
      while (!download && Date.now() - t0 < CHALLENGE_WAIT_MS) {
        const title = await page.title().catch(() => "");
        if (!CHALLENGE.test(title)) break;
        await pause(1000);
      }
      if (!download) await pause(DOWNLOAD_WAIT_MS / 5);
    }
    // HTTPS only: a page that sent the browser down to plain HTTP is refused (src/http.ts).
    const landed = download ? (download as Download).url() : page.url();
    if (/^http:\/\//i.test(landed)) throw new Error(`${PLAIN_HTTP} (${new URL(landed).hostname})`);
    if (download) {
      const d = download as Download;
      // A stream, not d.path(): the file sits on the browser's host, which is another machine for every remote stage.
      const stream = await d.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return { bytes: Buffer.concat(chunks), contentType: "application/pdf", url: d.url(), via: "download" };
    }
    const title = await page.title().catch(() => "");
    if (CHALLENGE.test(title)) throw new Error(`challenge not cleared (${title.slice(0, 40)})`);
    if (status && status >= 400) throw new Error(`HTTP ${status}`);
    const docType = await page.evaluate(() => document.contentType).catch(() => "");
    const inViewer = /application\/pdf/i.test(contentType) || /application\/pdf/i.test(docType);
    if (inViewer) {
      // Let the viewer finish loading the document, then take the largest body seen.
      const t1 = Date.now();
      while (Date.now() - t1 < DOWNLOAD_WAIT_MS) {
        await Promise.all(pdfReads);
        if (pdfBest && (pdfBest as Buffer).length > 4096) break;
        if (!pdfReads.length && Date.now() - t1 > 3000) break;   // the viewer is not fetching anything: use the request path
        await new Promise((r) => setTimeout(r, 500));
      }
      if (pdfBest) return { bytes: pdfBest, contentType: "application/pdf", url: page.url(), via: "response" };
    }
    if (inViewer) {
      // Rendered in the viewer: fetch the bytes with the context's cookies.
      const r = await ctx.request.get(page.url(), { timeout: NAV_TIMEOUT_MS });
      if (!r.ok()) throw new Error(`HTTP ${r.status()} (pdf request)`);
      return { bytes: Buffer.from(await r.body()), contentType: "application/pdf", url: page.url(), via: "request" };
    }
    const words = () => page.evaluate(() => (document.body?.innerText ?? "").split(/\s+/).filter(Boolean).length).catch(() => 0);
    if ((await words()) < SETTLE_WORDS) {
      await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
      const t2 = Date.now();
      while (Date.now() - t2 < SETTLE_MS && (await words()) < SETTLE_WORDS) await new Promise((r) => setTimeout(r, 1000));
    }
    const html = await page.content();
    return { bytes: Buffer.from(html, "utf8"), contentType: contentType || "text/html", url: page.url(), via: "page" };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await page.close().catch(() => undefined);
    if (isRemote(endpoint)) await ctx.storageState({ path: stateFile(endpoint) }).catch(() => undefined);   // cookies survive a kill
  }
}
