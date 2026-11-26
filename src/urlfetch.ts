import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { browserFetch, browserStages, MISMATCH, stageKind, stageName } from "./browser.js";
import { recordStage, walled, wallNote } from "./walls.js";
import { isWallPage } from "./checks.js";
import { settings } from "./config.js";
import { daysSince, now, writeAtomic } from "./entry.js";
import { htmlToMarkdown } from "./html.js";
import { BROWSER_HEADERS, fetchBytes, toHttps } from "./http.js";
import { pageMeta, sourceLine, withSourceLine, type PageMeta } from "./pagemeta.js";
import { fetchProxy, fetchProxyName } from "./fetchproxy.js";
import { looksLikePdf, pdfToMarkdown } from "./pdf.js";
import { errMsg } from "./tiers/tier.js";
import { accountProblem, unlock, unlockers } from "./unlock.js";
import { firstOk, openRequest, type Req, type Task } from "./race.js";
import { downNote, hostState } from "./hosts.js";
import { stripScripts, stripTags } from "./text.js";

// fh_fetch_url(url, …): the standard MCP "fetch" tool, served from the
// library. The answer is what the reference fetch server
// (modelcontextprotocol/servers, src/fetch) returns — "Contents of <url>:"
// and the page as Markdown, cut at max_length with the note on how to
// continue — so a model keeps its fetch habits. Two things differ under the
// hood: the page is fetched through the multi-stage download (plain fetch, the
// Playwright and Chrome stages, Bright Data) when a plain fetch is refused, and
// it is stored: the same URL within FH_REFRESH_AFTER_DAYS is served
// from disk, a failed fetch is not repeated within FH_RETRY_AFTER_DAYS.
// A PDF is converted to Markdown (fetch would return its bytes as text).
//
// Entry: url/<h2>/<h4>/<hash>/url-<hash>-{meta.md, page.md, page.<html|pdf|txt>}
// where hash is the first 16 hex digits of the normalised URL's SHA-1
// (as src/layout.ts lays out entries). The meta file holds the URL.

// ---------------------------------------------------------------- identity

// One URL, one entry: the scheme and host lowercased, the fragment dropped
// (never sent to the server), tracking parameters dropped. The path, the
// remaining query and their encoding stay as given.
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src)$/i;
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ([...u.searchParams.keys()].some((k) => TRACKING.test(k))) {
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    if (![...u.searchParams.keys()].length) u.search = "";
  }
  return u.toString();
}

export const urlHash = (normalized: string) => createHash("sha1").update(normalized).digest("hex").slice(0, 16);

export type UrlPaths = { hash: string; entry: string; entryDir: string; meta: string; md: string; raw: (ext: string) => string };
export function urlPaths(libraryDir: string, normalized: string): UrlPaths {
  const hash = urlHash(normalized);
  const entry = `url-${hash}`;
  const entryDir = join(libraryDir, "url", hash.slice(0, 2), hash.slice(0, 4), hash);
  return { hash, entry, entryDir, meta: join(entryDir, `${entry}-meta.md`), md: join(entryDir, `${entry}-page.md`), raw: (ext) => join(entryDir, `${entry}-page.${ext}`) };
}

// -------------------------------------------------------------------- meta

export type UrlFormat = "html" | "pdf" | "markdown" | "text" | "failed";
export type UrlMeta = {
  url: string;          // as normalised
  final_url: string;    // after redirects
  title: string | null;
  format: UrlFormat;
  content_type: string;
  level: "full_text" | "title";   // title: nothing to read (a failed fetch) — fh_info counts it as such
  retrieved_by: string;           // fetch | fetch-proxy <label> | playwright <label> | chrome <label> | firecrawl | zenrows | zyte | brightdata (browser <label> before 0.2.24)
  fetched: string;                // when, UTC to the second (YYYY-MM-DDTHH:MM:SSZ; older entries a bare date)
  error: string | null;           // the failure, for format failed
  files: string[];
  converted_by: string;
  source: string;                 // who published the page and when, as the line under its title (src/pagemeta.ts); "" when it says none
  published: string;              // its published / modified dates as it states them (YYYY-MM-DD mostly); "" when it does not
  modified: string;
};

function renderUrlMeta(m: UrlMeta): string {
  const lines: [string, string][] = [
    ["url", m.url], ["final_url", m.final_url], ["title", m.title === null ? "" : JSON.stringify(m.title)],
    ["format", m.format], ["content_type", m.content_type], ["level", m.level],
    ["retrieved_by", m.retrieved_by], ["fetched", m.fetched], ["error", m.error ?? ""],
    ["files", m.files.join(", ")], ["converted_by", m.converted_by],
    ["source", m.source ? JSON.stringify(m.source) : ""], ["published", m.published], ["modified", m.modified],
  ];
  return lines.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n";
}

export function readUrlMeta(p: UrlPaths): UrlMeta | null {
  if (!existsSync(p.meta)) return null;
  const md = readFileSync(p.meta, "utf8");
  // [ \t]*, not \s*: an empty value must not let the match run on to the next line ("title: \nformat: text" read as title "format: text").
  const f = (k: string) => { const m = new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(md); return m ? m[1].trim() : ""; };
  let title: string | null = null;
  try { title = f("title") ? JSON.parse(f("title")) : null; } catch { title = f("title") || null; }
  return {
    url: f("url"), final_url: f("final_url"), title, format: (f("format") || "failed") as UrlFormat, content_type: f("content_type"),
    level: f("level") === "full_text" ? "full_text" : "title", retrieved_by: f("retrieved_by"), fetched: f("fetched"), error: f("error") || null,
    files: f("files") ? f("files").split(",").map((s) => s.trim()).filter(Boolean) : [], converted_by: f("converted_by"),
    source: (() => { try { return f("source") ? JSON.parse(f("source")) : ""; } catch { return f("source"); } })(), published: f("published"), modified: f("modified"),
  };
}

function writeUrlMeta(p: UrlPaths, m: UrlMeta): void {
  mkdirSync(p.entryDir, { recursive: true });
  writeAtomic(p.meta, renderUrlMeta(m));
}

// A page answered 200 but holds no page: a script shell a browser would fill in
// ("Loading…", "enable JavaScript", or almost no visible text at all — an SPA
// without server rendering). The multi-stage paper download escalates such pages as "no
// article body"; here a short page may be legitimate, so the tell is the
// loading/JavaScript phrase, or next to nothing to read. Judged on the
// converted Markdown — what the model would get — not the raw HTML: a chat
// widget's hidden labels gave lifeextension.com's 85-word "Connecting to
// Agent…" shell 100+ raw words (2026-11-08).
const SHELL_WORDS = 100, EMPTY_WORDS = 10;
const SHELL_PHRASE = /\bloading\b|javascript|enable it|connecting to|please wait|redirecting/i;
export function isScriptShell(markdownOrHtml: string): { shell: boolean; words: number } {
  const text = stripTags(stripScripts(markdownOrHtml), " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\]\([^)]*\)/g, ")");
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { shell: words < EMPTY_WORDS || (words < SHELL_WORDS && SHELL_PHRASE.test(text)), words };
}

// ------------------------------------------------------------------ stages

export type Got =
  | { ok: true; bytes: Buffer; contentType: string; url: string; via: string }
  | { ok: false; reason: string; url?: string; via: string; first?: string; shell?: Got };   // first: the plain fetch's reason when later stages failed too; shell: the script shell that came back, served when no stage does better
type Via = "fetch" | { unlocker: string } | { browser: string; label: string } | { proxy: string; label: string };
const viaName = (via: Via) => typeof via === "object" ? ("unlocker" in via ? via.unlocker : "proxy" in via ? fetchProxyName(via) : stageName({ kind: stageKind(via.browser), label: via.label })) : via;

async function stage(url: string, via: Via, signal?: AbortSignal): Promise<Got> {
  const name = viaName(via);
  let got: { bytes: Buffer; contentType: string; url?: string };
  try {
    got = typeof via === "object" && "unlocker" in via ? await unlock(url, via.unlocker, signal)
        : typeof via === "object" ? ("proxy" in via ? await fetchBytes(url, BROWSER_HEADERS, via.proxy, signal) : await browserFetch(url, via.browser, undefined, signal))
        : await fetchBytes(url, BROWSER_HEADERS, undefined, signal);
  } catch (e) {
    return { ok: false, reason: errMsg(e), url: (e as { url?: string })?.url, via: name };
  }
  if (typeof via === "object" && "unlocker" in via && !got.bytes.length) return { ok: false, reason: "empty response", via: name };
  const r: Got = { ok: true, bytes: got.bytes, contentType: got.contentType, url: got.url ?? url, via: name };
  if (!looksLikePdf(got.bytes)) {
    const text = got.bytes.toString("utf8");
    if (isHtml(got.contentType, text)) {
      if (isWallPage(text)) return { ok: false, reason: "wall page", url: r.url, via: name };
      let md = "";
      try { md = htmlToMarkdown(/<body[^>]*>([\s\S]*)<\/body>/i.exec(text)?.[1] ?? text); } catch { /* judged on the raw text then */ }
      const s = isScriptShell(md || text);
      if (s.shell) return { ok: false, reason: `script shell (${s.words} words)`, url: r.url, via: name, shell: r };
    }
  }
  return r;
}

// As src/download.ts climbs for a paper, in three stages, each only when
// configured, every outcome reported:
//   1. fetch: the plain fetch and the fetch proxy (the same fetch from another IP);
//   2. browsers, on a 403, 429, wall page or script shell (either met): every Playwright server and Chrome;
//   3. unlockers, on a 403, a wall page or after the browsers (src/unlock.ts).
// Within a stage all requests run at once; the first valid result wins (src/race.ts).
export type Climb = (url: string, onTry?: (line: string) => void, onAlert?: (line: string) => void) => Promise<Got>;
export const climb: Climb = async (given, onTry, onAlert) => {
  // HTTPS only (src/http.ts): an http:// URL is fetched as https://, said once.
  const url = toHttps(given);
  if (url !== given) onTry?.(`http upgraded → ${url}`);
  // A 404 or 410 seen by any stage says more than a 403 or a wall the plain fetch met:
  // the page is not there, not merely blocked — that is the error the model gets (#62).
  let gone: string | undefined;
  let shell: Got | undefined;   // the first script shell seen: what fetch itself would have returned
  const seen = (g: Got): Got => { if (!g.ok) { gone ??= goneReason(g.reason); if (g.shell && !shell) shell = g.shell; } return g; };
  // One request as a task (src/race.ts): "try <name>", then exactly one closing line —
  // its outcome, or "aborted"/"abandoned". An aborted request records and reports nothing more.
  const write = (line: string) => onTry?.(line);
  const run = (target: string, via: Via, name: string, after?: (g: Got) => void): Task<Got> => {
    let req: Req | null = null;
    return {
      name,
      abort: (why) => req?.abort(why),
      go: async () => {
        req = openRequest(write, name);
        const g = await stage(target, via, req.signal);
        if (req.signal.aborted) return { ok: false, reason: "aborted", via: name } as Got;
        seen(g);
        if (via !== "fetch") recordStage(target, name, g.ok, g.ok ? "" : g.reason);
        after?.(g);
        req.close(g.ok ? `ok ${name}` : `failed ${name}: ${g.reason}`);
        if (!g.ok && (g.reason.startsWith(MISMATCH) || accountProblem(g.reason))) onAlert?.(`${name}: ${g.reason}`);   // a browser server's version, an unlocker's key/credit/IP — ours to fix
        return g;
      },
    };
  };
  const skipped = (target: string, name: string) => { const w = walled(target, name); if (w) onTry?.(`skipped ${name}: ${wallNote(w)}`); return !!w; };
  // Our own stage host off or off the network: skipped at once (src/hosts.ts); newly down, an alert.
  const hostDown = async (host: string, port: number, name: string) => {
    const h = await hostState(host, port, (s) => onAlert?.(`${name}: ${downNote(s)}`));
    if (!h.up) onTry?.(`skipped ${name}: ${downNote(h)}`);
    return !h.up;
  };

  // Stage 1, fetch: the plain fetch and the fetch proxy together.
  const f = fetchProxy();
  const proxyName = f ? fetchProxyName(f) : "";
  const first = [run(url, "fetch", "fetch", (g) => { if (!g.ok && g.url && g.url !== url) onTry?.(`redirect → ${g.url}`); })];
  if (f && !skipped(url, proxyName) && !(await hostDown(f.host, f.port, proxyName))) first.push(run(url, { proxy: f.proxy, label: f.label }, proxyName));
  const isGone = (g: Got) => g.ok ? null : goneReason(g.reason) ?? null;
  const one = await firstOk(first, isGone);
  if (one.won) return one.won;
  const plain = one.results[0] ?? one.results.find(Boolean)!;
  const firstReason = plain.ok ? undefined : plain.reason;
  // Later stages get the URL the plain fetch was redirected to.
  const target = !plain.ok && plain.url && plain.url !== url ? plain.url : url;
  let r: Got = one.results[1] ?? plain;
  // The plain fetch and the fetch proxy climb on what either met; a browser's own failure always moves on.
  const plainVia = (g: Got) => g.via === "fetch" || g.via.startsWith("fetch-proxy ");
  const met = (g: Got, re: RegExp) => re.test(g.ok ? "" : g.reason) || (plainVia(g) && re.test(firstReason ?? ""));
  const escalates = (g: Got) => !g.ok && (!plainVia(g) || met(g, /^(HTTP 403|HTTP 429|wall page|script shell)/));

  // A 404 or 410 ends the download: the page is not there (#62) — no further stage.
  const notThere = (): Got | null => gone ? { ...r, ok: false, reason: gone, via: r.via } as Got : null;
  if (gone) return { ...(notThere()!), first: gone };
  // Stage 2, browsers: every Playwright server and Chrome at once.
  if (escalates(r)) {
    const open = browserStages().filter((b) => !skipped(target, stageName(b)));
    const down = await Promise.all(open.map((b) => hostDown(b.host, b.port, stageName(b))));
    const tasks = open.filter((_, i) => !down[i]).map((b) => run(target, { browser: b.endpoint, label: b.label }, stageName(b)));
    const two = await firstOk(tasks, isGone);
    if (two.won) return two.won;
    if (two.results.length) r = two.results.filter(Boolean).pop()!;
    if (gone) return { ...(notThere()!), first: gone };
  }

  // Stage 3, unlockers: all at once.
  const unlockable = !r.ok && (!plainVia(r) || met(r, /^(HTTP 403|wall page|script shell)/));
  const us = (unlockable ? unlockers() : []).filter((u) => !skipped(target, u));
  const three = await firstOk(us.map((u) => run(target, { unlocker: u }, u)), isGone);
  if (three.won) return three.won;
  if (three.results.length) r = three.results.filter(Boolean).pop()!;
  // No stage filled the shell in: the shell itself is the answer, as fetch would
  // give it — the model sees the "Loading…" page rather than an error.
  if (!r.ok && shell) { onTry?.("shell kept: no stage rendered the page, the script shell is served"); return shell; }
  // The error the model sees is the plain fetch's when it was an HTTP status
  // ("status code 403", as fetch says it), not the last stage's words.
  return r.ok || r.via === "fetch" ? r : { ...r, first: gone ?? firstReason };
};
const GONE = /\bHTTP (404|410)\b/;
// "HTTP 404" when a stage's reason says the page is not there (404, 410), with or without the stage's prefix; else undefined.
export const goneReason = (reason: string): string | undefined => reason.match(GONE)?.[0];

// ----------------------------------------------------------------- content

const mediaType = (contentType: string) => contentType.split(";")[0].trim().toLowerCase();

// The reference server's test: "<html" in the first 100 characters, an HTML
// media type, or — with no Content-Type at all — a body that opens with the
// doctype or the html tag.
export function isHtml(contentType: string, text: string): boolean {
  const ct = contentType.toLowerCase();
  if (/<html/i.test(text.slice(0, 100))) return true;
  if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) return true;
  return !ct && /^(<!doctype html|<html)/.test(text.replace(/^\uFEFF/, "").trimStart().slice(0, 20).toLowerCase());
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const visibleText = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/¶\s*$/, "").trim();
const normalized = (text: string) => { const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu); return words ? ` ${words.join(" ")} ` : ""; };

// The page's title as the reference server picks it: og:title; the first
// <h1> when the <title> holds it (the <title> then only adds the site's
// name); the <title>; the <h1>; else null.
export function pageTitle(html: string): string | null {
  const head = html.slice(0, 200_000);
  const og = /<meta\b[^>]*\bproperty\s*=\s*["']og:title["'][^>]*>/i.exec(head)?.[0] ?? /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*["'][^>]*\bproperty\s*=\s*["']og:title["'][^>]*>/i.exec(head)?.[0];
  const ogTitle = og ? visibleText(/\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(og)?.[2] ?? /\bcontent\s*=\s*'([^']*)'/i.exec(og)?.[1] ?? "") : "";
  const title = visibleText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "");
  const h1 = visibleText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "");
  const headingInTitle = !!normalized(h1) && normalized(title).includes(normalized(h1));
  if (ogTitle) return ogTitle;
  if (headingInTitle) return h1;
  return title || h1 || null;
}

// What a reader sees of a Markdown line: link targets and tags dropped.
const visibleLine = (line: string) => line.replace(/\]\([^)]*\)/g, " ").replace(/<[a-zA-Z/!?][^>]*>/g, " ");

function opensWithTitle(content: string, title: string): boolean {
  const first = content.split("\n").find((l) => l.trim()) ?? "";
  const line = normalized(visibleLine(first)), wanted = normalized(title);
  if (!line || !wanted) return false;
  if (line.includes(wanted)) return true;
  return first.trimStart().startsWith("#") && wanted.includes(line);
}

// The content with the page's title as a heading on top, if it lacks one.
export function withPageTitle(html: string, content: string): string {
  if (content.startsWith("<error>")) return content;
  const title = pageTitle(html);
  if (title === null || opensWithTitle(content, title)) return content;
  return `# ${title.replace(/([\\`*_\[\]<>#&|~])/g, "\\$1")}\n\n${content.trimStart()}`;
}

export const SIMPLIFY_FAILED = "<error>Page failed to be simplified from HTML</error>";

// Clutter a model never needs to judge a page, dropped from the Markdown on
// ingestion (measured 2026-11-10 on 471 live pages, ~14% of the text in all):
//   * an empty link "[](…)" — an image link whose image was dropped
//   * the target of a link that stays on the page's site — "#…", a relative
//     path, the same host — and of one to no page (javascript:, mailto:,
//     tel:); the link text stays. The model fetches a page to judge it, not to
//     browse the site. A document on the same site (a PDF) keeps its link.
//   * menu and breadcrumb lines before the first heading and footer lines after
//     the last paragraph: lines of nothing but short links (≤ 5 words each) — a
//     reference list of linked titles is longer and stays
//   * the attributes of raw HTML Turndown kept (complex tables), but colspan
//     and rowspan; runs of spaces inside a line, outside tables and code
// Only ever removes: a page re-converted from its stored HTML never says
// less than it did. Link text with brackets is escaped by Turndown (\[ \]).
const MD_LINK = /\[((?:\\.|[^\]\\])*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/g;   // a target may hold one level of parentheses: javascript:void(0), /wiki/X_(y)
const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|csv)(?:$|[?#])|doi\.org\//i;
function internal(target: string, site: string): boolean {
  if (/^(#|javascript:|mailto:|tel:)/i.test(target)) return true;
  if (DOCUMENT.test(target)) return false;
  if (/^\/\//.test(target)) return !!site && host(`https:${target}`) === site;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) return true;   // relative: /path, page.html, ../x, ?q=
  return !!site && /^https?:/i.test(target) && host(target) === site;
}
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
// A line of nothing but short links: a menu or footer row.
function menuLine(line: string): boolean {
  const links = [...line.matchAll(MD_LINK)];
  if (!links.length) return false;
  if (line.replace(MD_LINK, "").replace(/[\s\-*+|•·>›»\/]+/g, "").replace(/^\d+\.$/, "").length >= 4) return false;   // separators of menus and breadcrumbs
  return links.every((l) => words(l[1]) <= 5);
}

export function tidyMarkdown(md: string, pageUrl = ""): string {
  const site = host(pageUrl);
  const lines = md.split("\n");
  // Code fences are left exactly as they are.
  let fence = false;
  const code = lines.map((l) => { const isFence = /^\s*(```|~~~)/.test(l); const inside = fence || isFence; if (isFence) fence = !fence; return inside; });
  const first = lines.findIndex((l, i) => !code[i] && /^#{1,6}\s/.test(l));
  let last = -1;
  lines.forEach((l, i) => { if (!code[i] && !menuLine(l) && words(l.replace(MD_LINK, "$1")) >= 12) last = i; });
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (code[i]) { out.push(l); return; }
    if (((first > 0 && i < first) || (last >= 0 && i > last)) && menuLine(l)) return;
    let t = l.replace(MD_LINK, (all, text: string, target: string) => !text.trim() ? "" : internal(target, site) ? text : all);
    t = t.replace(/<([a-zA-Z][\w-]*)(\s[^<>]*?)?(\/?)>/g, (_all, tag: string, attrs: string | undefined, close: string) =>
      `<${tag}${(attrs ?? "").match(/\s(?:colspan|rowspan)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi)?.join("") ?? ""}${close}>`);
    if (!/^\s*\|/.test(t)) t = t.replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ");
    out.push(t.replace(/[ \t]+$/, ""));
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n*$/, "\n");
}

// "evidence-mcp 0.2.26" → [0, 2, 26]; whether a stamp is older than ours.
const versionOf = (stamp: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(stamp) ?? []).slice(1, 4).map(Number);
export function olderConverter(stored: string, current: string): boolean {
  const a = versionOf(stored), b = versionOf(current);
  if (b.length < 3) return false;
  if (a.length < 3) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

type Page = { format: Exclude<UrlFormat, "failed">; md: string | null; title: string | null; ext: string; meta?: PageMeta };
async function convert(bytes: Buffer, contentType: string, pageUrl = ""): Promise<Page> {
  if (looksLikePdf(bytes)) {
    const md = (await pdfToMarkdown(bytes, "", "")).replace(/^# \n\n/, "");
    return { format: "pdf", md, title: null, ext: "pdf" };
  }
  const text = bytes.toString("utf8");
  if (mediaType(contentType) === "text/markdown") return { format: "markdown", md: text, title: null, ext: "md" };
  if (isHtml(contentType, text)) {
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text)?.[1] ?? text;
    let md: string;
    try { md = tidyMarkdown(htmlToMarkdown(body), pageUrl); } catch { md = ""; }
    const meta = pageMeta(text);
    md = md.trim() ? withSourceLine(withPageTitle(text, md), sourceLine(meta)) : SIMPLIFY_FAILED;
    return { format: "html", md, title: pageTitle(text), ext: "html", meta };
  }
  return { format: "text", md: null, title: null, ext: "txt" };
}

// ------------------------------------------------------------------ answer

// The reference server's cut: the content from start_index, at most
// max_length characters, the note when more follows.
export function fetchAnswer(url: string, body: string, prefix: string, maxLength: number, startIndex: number): string {
  const original = body.length;
  let content: string;
  if (startIndex >= original) content = "<error>No more content available.</error>";
  else {
    const cut = body.slice(startIndex, startIndex + maxLength);
    content = cut;
    const remaining = original - (startIndex + cut.length);
    if (cut.length === maxLength && remaining > 0) content += `\n\n<error>Content truncated. Call the fetch tool with a start_index of ${startIndex + cut.length} to get more content.</error>`;
  }
  return `${prefix}Contents of ${url}:\n${content}`;
}

// The log's ID column for a URL: no scheme, cut to the width of a PubMed ID
// ("pmid:30955454", 13); the full URL closes every line.
export const ID_WIDTH = 13;
export function logId(url: string): string {
  const bare = url.replace(/^https?:\/\//i, "");
  return bare.length > ID_WIDTH ? bare.slice(0, ID_WIDTH - 1) + "…" : bare;
}

// libraryIdForUrl lives in src/ids.ts (parseId takes such a URL as its ID too); re-exported here for fh_fetch_url.
export { libraryIdForUrl } from "./ids.js";

export const failureText = (url: string, reason: string) => {
  const m = /^HTTP (\d{3})\b/.exec(reason);
  return m ? `Failed to fetch ${url} - status code ${m[1]}` : `Failed to fetch ${url}: ${reason}`;
};

export type FetchArgs = { max_length?: number; start_index?: number; raw?: boolean; title_only?: boolean };
export type FetchOutcome = { ok: true; text: string; cached: boolean; meta: UrlMeta } | { ok: false; error: string; cached: boolean; meta: UrlMeta | null };
export type FetchLog = { onTry?: (line: string) => void; onAlert?: (line: string) => void };

// The page's title line: the stored title as a heading, else the Markdown's
// first non-empty line, else the content type — what a link check needs.
export function titleLine(m: UrlMeta, md: string): string {
  if (m.title) return `# ${m.title}`;
  const first = md.split("\n").find((l) => l.trim());
  if (first) return first.trim();
  return `(${m.content_type || "no content type"}, no title)`;
}

function serve(requested: string, p: UrlPaths, m: UrlMeta, args: FetchArgs, cached: boolean): FetchOutcome {
  const maxLength = args.max_length ?? 5000, startIndex = args.start_index ?? 0;
  const read = (file: string) => existsSync(file) ? readFileSync(file, "utf8") : "";
  // title_only: the whole page was fetched and stored as usual; the model gets one line of it.
  if (args.title_only) return { ok: true, text: `Contents of ${requested}:\n${titleLine(m, read(p.md))}`, cached, meta: m };
  const rawFile = m.files.find((f) => !f.endsWith("-meta.md") && !f.endsWith("-page.md"));
  let body: string, prefix = "";
  if (m.format === "markdown") body = read(p.md);
  else if (m.format === "text" || args.raw) {
    body = rawFile ? read(join(p.entryDir, rawFile)) : read(p.md);
    prefix = `Content type ${m.content_type || "(not declared)"} cannot be simplified to markdown, but here is the raw content:\n`;
  } else body = read(p.md);
  return { ok: true, text: fetchAnswer(requested, body, prefix, maxLength, startIndex), cached, meta: m };
}

const sourceFields = (page: Page) => page.meta ? { source: sourceLine(page.meta), published: page.meta.published ?? "", modified: page.meta.modified ?? "" } : { source: "", published: "", modified: "" };

const inflight = new Map<string, Promise<void>>();

// The tool's work: serve from disk when the stored page (or failure) is young
// enough, else fetch through the stages, store, serve. Two calls on one URL share
// one fetch. `fetchImpl` is the multi-stage fetch; tests pass their own.
export async function libraryFetch(libraryDir: string, requested: string, args: FetchArgs, converter: string, logs: FetchLog = {}, fetchImpl: Climb = climb): Promise<FetchOutcome> {
  const url = normalizeUrl(requested);
  if (!url) return { ok: false, error: `Failed to fetch ${requested}: invalid URL`, cached: false, meta: null };
  const p = urlPaths(libraryDir, url);
  const s = settings();
  const fresh = (m: UrlMeta) => daysSince(m.fetched) < (m.format === "failed" ? s.retry_after_days : s.refresh_after_days);
  const answer = (m: UrlMeta, cached: boolean): FetchOutcome => m.format === "failed" ? { ok: false, error: failureText(requested, m.error ?? "unknown error"), cached, meta: m } : serve(requested, p, m, args, cached);

  let stored = readUrlMeta(p);
  // Converted by an older version: converted again from the stored HTML (no
  // fetch) and stamped with ours. A newer stamp is left alone — two versions
  // sharing a library do not convert a page back and forth.
  if (stored && fresh(stored) && stored.format === "html" && olderConverter(stored.converted_by, converter)) {
    const html = stored.files.find((f) => f.endsWith("-page.html"));
    if (html && existsSync(join(p.entryDir, html))) {
      try {
        const page = await convert(readFileSync(join(p.entryDir, html)), stored.content_type || "text/html", stored.final_url || stored.url);
        if (page.md !== null) {
          writeAtomic(p.md, page.md);
          writeUrlMeta(p, { ...stored, title: page.title, converted_by: converter, ...sourceFields(page) });
          stored = readUrlMeta(p);
        }
      } catch { /* the stored Markdown is served as it is */ }
    }
  }
  if (stored && fresh(stored)) return answer(stored, true);

  let run = inflight.get(p.hash);
  if (!run) {
    run = (async () => {
      const r = await fetchImpl(url, logs.onTry, logs.onAlert);
      const base = { url, fetched: now(), converted_by: converter, source: "", published: "", modified: "" };
      if (!r.ok) {
        const error = r.first && /^HTTP \d{3}/.test(r.first) ? r.first : r.reason;
        writeUrlMeta(p, { ...base, final_url: r.url ?? url, title: null, format: "failed", content_type: "", level: "title", retrieved_by: r.via, error, files: [`${p.entry}-meta.md`] });
        return;
      }
      const page = await convert(r.bytes, r.contentType, r.url);
      mkdirSync(p.entryDir, { recursive: true });
      const files = [`${p.entry}-meta.md`];
      if (page.md !== null) { writeAtomic(p.md, page.md); files.push(`${p.entry}-page.md`); }
      if (page.ext !== "md") { writeAtomic(p.raw(page.ext), r.bytes); files.push(`${p.entry}-page.${page.ext}`); }
      writeUrlMeta(p, { ...base, ...sourceFields(page), final_url: r.url, title: page.title, format: page.format, content_type: mediaType(r.contentType), level: "full_text", retrieved_by: r.via, error: null, files });
    })().finally(() => inflight.delete(p.hash));
    inflight.set(p.hash, run);
  }
  await run;
  const m = readUrlMeta(p);
  if (!m) return { ok: false, error: `Failed to fetch ${requested}: nothing stored`, cached: false, meta: null };
  return answer(m, false);
}

// ---- Design notes: Web pages — `fh_fetch_url` ----
//
// The standard MCP `fetch` tool with the library behind it. Decisions, 2026-11-08:
//
// * **The answer is the reference server's, byte for byte where it can be:** `Contents of <url>:`, the truncation note, `No more content available`, the `Content type … cannot be simplified` prefix, the `Failed to fetch …` errors, the page title as a `#` heading on top (og:title, else the h1 the title holds, else the title, else the h1 — `src/urlfetch.ts` follows `title.py` of modelcontextprotocol/servers). No header line of ours, no `cached:` flag: a model that knows `fetch` must not have to learn anything. The cache shows in the log and in `fh_info` only.
// * **Why a replica and not a `url:` ID for add/read/verify:** the model's first move on a link is `fetch(url)`; making it `fh_library_add` then `fh_library_read` would be a new habit to teach. AI4L's URL step (d-browser → d-fetch → d-proxy) becomes one call.
// * **Source line (2026-11-10):** the page type, publisher, authors, reviewed by, published and updated dates under the title, from JSON-LD, else meta tags (`src/pagemeta.ts`); the rest of the head is for search engines and stays out.
// * **Clutter dropped (2026-11-10), the second deliberate deviation:** empty links; the targets of links that stay on the page's site (in-page, relative, same host — a same-site PDF keeps its link) and of `javascript:`, `mailto:`, `tel:` links, text kept; menu rows before the first heading and footer rows after the last paragraph; raw-HTML attributes; space runs (`tidyMarkdown`). The model fetches a page to check a search result, not to browse the site; measured on 471 live pages ~14%. Readability (what the reference server uses) was measured too, 2026-11-10: −14%, but it dropped real text — ConsumerLab's source lists, a search page's results, a study title — so not used. On ingestion, so `page.md` is one text for every reader; a page converted by an older version is converted again from its stored `page.html` when next served, and stamped with this version (`converted_by`) — never by an older server over a newer stamp. Once per release on purpose (decided 2026-11-10): no converter number to remember to raise, every change reaches every served page, and a release that converts worse is corrected by the next one from the same stored HTML; the cost is milliseconds per page served.
// * **PDF kept:** `fetch` returns a PDF's bytes as text; the library has the converter, so a guideline PDF comes back as Markdown. A deliberate deviation.
// * **The multi-stage fetch is a second copy** of the escalation loop in `src/download.ts` (fetch → browser stages → Bright Data, the same triggers), not an extraction: the multi-stage paper download is bound to conversion checks (wall page, no article body) that a web page has no equivalent for.
// * **Script shells:** the multi-stage paper download escalates "no article body"; a web page has no such check, so the tell is a 200 page whose Markdown is under 100 words with a loading/JavaScript phrase, or under 10 words (`isScriptShell`, judged on the converted Markdown — raw HTML counts a chat widget's hidden labels). It climbs like a wall page; a browser stage with so little text waits for network idle and for the text to grow, at most 8 s (`SETTLE_MS` in `src/browser.ts`). When no stage renders more, the shell is served: fetch would have returned it too, and an error would hide that the page exists. Measured 2026-11-08 on lifeextension.com's search: 75 words plain, 81 in every browser, 75 via Bright Data — a client-side search nothing renders.
// * **Entry:** `url/<h2>/<h4>/<hash>/`, hash = first 16 hex digits of the normalised URL's SHA-1 (64 bits; the URL itself is in the meta). A failed fetch is an entry too (`format: failed`, `level: title`), retried after `FH_RETRY_AFTER_DAYS`; a page is refetched after `FH_REFRESH_AFTER_DAYS`. `robots.txt` is not consulted (the multi-stage paper download never did; the fetch runs as a reader's browser).
