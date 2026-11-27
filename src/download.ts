import { checkFulltext, isWallPage, proseWords, anotherDocument } from "./checks.js";
import { downNote, hostState } from "./hosts.js";
import { htmlToMarkdown } from "./html.js";
import { DOWNLOAD_HEADERS, fetchBytes, toHttps } from "./http.js";
import { parseJats, renderFulltextMd } from "./jats.js";
import { looksLikePdf, pdfToMarkdown } from "./pdf.js";
import { browserFetch, browserStages, MISMATCH, STAGE_PREFIX, stageKind, stageName } from "./browser.js";
import { fetchProxy, fetchProxyName } from "./fetchproxy.js";
import { accountProblem, unlock, UNLOCKER_PREFIX, unlockers } from "./unlock.js";
import { firstOk, openRequest, type Req, type Task } from "./race.js";
import { recordStage, walled, wallNote } from "./walls.js";
import { errMsg, miss, type Candidate, type Paper, type RunContext, type TierHit, type TierResult } from "./tiers/tier.js";
import { stripScripts, stripTags } from "./text.js";
import { log } from "./log.js";

// The download helper: a tier that has located copies of the paper calls it
// to fetch them, PDFs first, and convert whatever comes back (PDF, JATS XML,
// HTML), checked. The fetch is multi-stage, as AI4L verifies URLs:
//   fetch    Node fetch from this host, a desktop Chrome User-Agent (API calls identify the library)
//   fetch proxy  the same fetch through an HTTP proxy on another host (src/fetchproxy.ts,
//             FH_FETCH_PROXY), on every failed fetch
//   browsers  Chromium via Playwright (src/browser.ts), one stage per configured
//             browser server in order (next to the server, then a residential
//             one), when the fetch met a 403, a bot wall, or a landing
//             page without the article (script-rendered)
//   unlockers   every web unlocker with a key (Firecrawl, ZenRows, Zyte, Bright Data), when
//               all of that was refused (src/unlock.ts)
// Three stages — 1 fetch (plain fetch, fetch proxy), 2 browsers, 3 unlockers —
// each only when the one before got no valid result. Within a stage all requests
// run at once; the first valid result wins (src/race.ts). Each request logs
// "try <name>" and one closing line: ok, failed, aborted or abandoned.
// Each step only runs when configured; what every step answered is logged.
// URLs already tried in this cascade run are skipped.

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

// NCBI/PMC web URLs are never fetched: PMC content comes through E-utilities
// (the pmc tier), and NCBI's pages are for humans.
const NCBI = /^https?:\/\/([a-z0-9.-]+\.)?(ncbi\.nlm\.nih\.gov|pubmed\.gov)\//i;

// Fetch order: PDFs before landing pages, repositories before publisher sites
// (repositories rarely wall), as located.
function order(candidates: Candidate[]): Candidate[] {
  const rank = (c: Candidate) => (c.pdf ? 0 : 2) + (c.host === "publisher" ? 1 : 0);
  return [...candidates].sort((a, b) => rank(a) - rank(b));
}

export async function download(tier: string, p: Paper, candidates: Candidate[], ctx: RunContext): Promise<TierResult> {
  const usable = candidates.filter((c) => !NCBI.test(c.url));
  if (!usable.length && candidates.length) return miss(tier, "only pmc copies (covered by the pmc tier)");
  // HTTPS only (src/http.ts): an http:// copy is fetched as https://, said once.
  const ordered = order(usable.map((c) => { const u = toHttps(c.url); if (u !== c.url) ctx.onTry?.(`http upgraded: ${c.url} → ${u}`); return u === c.url ? c : { ...c, url: u }; })).filter((c) => !ctx.tried.has(c.url));
  if (!ordered.length) return miss(tier, "only copies already tried");
  const reasons: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    ctx.tried.add(c.url);
    // A landing page that names its PDF (citation_pdf_url, a repository's download link):
    // the first one any stage saw, fetched next as a candidate of its own.
    let link: string | undefined;
    // A 404 or 410 any stage saw is the copy's recorded reason, not a 403 or wall met earlier (#62).
    let gone: string | undefined;
    const note = <R extends Attempt>(x: R): R => { if (!x.ok && x.pdfUrl) link ??= x.pdfUrl; if (!x.ok && !gone && /\bHTTP (404|410)\b/.test(x.reason)) gone = x.reason; return x; };
    // "not a pdf (wall page)" escalates like "wall page": the wrapper only says a PDF was expected.
    const why = (reason: string) => reason.replace(/^not a pdf \((.*)\)$/, "$1");
    // One stage as a task: run, record, report (src/race.ts runs several at once).
    // One request as a task (src/race.ts): "try <name>", then exactly one closing line —
    // its outcome, or "aborted"/"abandoned". An aborted request records and reports nothing more.
    const run = (cand: Candidate, via: Via, name: string): Task<Attempt> => {
      let req: Req | null = null;
      return { name, abort: (why) => req?.abort(why), go: async () => {
      req = openRequest((line) => ctx.onTry?.(`${line} ${cand.url}`), name);   // the event first, the full URL last
      const x0 = await tryOne(p, cand, tier, via, req.signal);
      if (req.signal.aborted) return { ok: false, reason: "aborted" } as Attempt;
      const x = note(x0);
      if (via !== "plain") recordStage(cand.url, name, x.ok, x.ok ? "" : x.reason);
      req.close(x.ok ? `ok ${name}` : `failed ${name}: ${via === "plain" ? x.reason : bare(x.reason)}`);
      // A browser server refused this client (another Playwright version, #19), or an unlocker refused
      // us (key, credit, IP not allowed): alerts — ours to fix, not the paper's. A 5xx or a page an
      // unlocker could not get is a failed stage like any other (2026-11-11: a Bright Data 502 raised as an alert on live).
      if (!x.ok && (bare(x.reason).startsWith(MISMATCH) || accountProblem(bare(x.reason)))) ctx.onAlert?.(`${name}: ${bare(x.reason)}`);
      return x;
      } };
    };
    const skipped = (url: string, name: string) => { const w = walled(url, name); if (w) ctx.onTry?.(`skipped ${name}: ${wallNote(w)} ${url}`); return !!w; };
    // Our own stage host off or off the network: skipped at once (src/hosts.ts); newly down, an alert.
    const hostDown = async (host: string, port: number, name: string, url: string) => {
      const h = await hostState(host, port, (s) => ctx.onAlert?.(`${name}: ${downNote(s)}`));
      if (!h.up) ctx.onTry?.(`skipped ${name}: ${downNote(h)} ${url}`);
      return !h.up;
    };

    // Stage 1, fetch: the plain fetch and the fetch proxy together — the proxy with the same headers (a token
    // too: it only tunnels the TLS), not for a configured service, whose access may hang on this IP.
    const f = fetchProxy();
    const first = [run(c, "plain", "fetch")];
    if (f && !c.service && !skipped(c.url, fetchProxyName(f)) && !(await hostDown(f.host, f.port, fetchProxyName(f), c.url))) first.push(run(c, { proxy: f.proxy, label: f.label }, fetchProxyName(f)));
    // A 404 or 410 from any request ends its stage and the download: the copy is not there (#62).
    const isGone = (x: Attempt) => x.ok ? null : x.reason.match(/\bHTTP (404|410)\b/)?.[0] ?? null;
    const one = await firstOk(first, isGone);
    if (one.won) return one.won as TierHit;
    const plain = one.results[0] ?? one.results.find(Boolean)!;
    // The later stages get the URL the plain fetch was redirected to (a doi.org
    // link resolved to the publisher's page): an unlocker may not follow doi.org's
    // redirect, and a browser saves the hop.
    const target: Candidate = !plain.ok && plain.url && plain.url !== c.url ? { ...c, url: plain.url } : c;
    if (target !== c) ctx.onTry?.(`redirect ${c.url} → ${target.url}`);
    // The browsers and the unlockers go by what the plain fetch met, or the proxy if that says more.
    const plainReason = why(reasonOf(plain));
    let r: Attempt = one.results[1] ?? plain;

    // Stage 2, browsers: every Playwright server and Chrome at once — not for candidates with their own headers (publisher APIs
    // with a token): neither a browser nor an unlocker carries them.
    const UNLOCK = /^(HTTP 403|wall page)/;
    let browsed = false;
    if (!gone && !c.headers && !c.service && (climbsOn(plainReason) || climbsOn(bare(reasonOf(r))))) {
      const open = browserStages().filter((b) => !skipped(target.url, stageName(b)));
      const down = await Promise.all(open.map((b) => hostDown(b.host, b.port, stageName(b), target.url)));
      const tasks = open.filter((_, i) => !down[i]).map((b) => run(target, { browser: b.endpoint, label: b.label }, stageName(b)));
      browsed = tasks.length > 0;
      const two = await firstOk(tasks, isGone);
      if (two.won) return two.won as TierHit;
      if (two.results.length) r = two.results.filter(Boolean).pop()!;
    }

    // Stage 3, unlockers (src/unlock.ts): all at once; each skipped while the host walls it.
    const unlockable = !gone && !r.ok && !c.headers && !c.service && (browsed ? /^(HTTP 403|wall page|playwright |chrome |browser )/.test(why(reasonOf(r))) : UNLOCK.test(plainReason) || UNLOCK.test(why(bare(reasonOf(r)))));
    const us = (unlockable ? unlockers() : []).filter((u) => !skipped(target.url, u));
    const three = await firstOk(us.map((u) => run(target, { unlocker: u }, u)), isGone);
    if (three.won) return three.won as TierHit;
    if (three.results.length) r = three.results.filter(Boolean).pop()!;
    if (r.ok) return r;
    reasons.push(`${gone ?? r.reason}: ${hostOf(c.url)}`);
    if (link && !ctx.tried.has(link) && !NCBI.test(link) && !ordered.slice(i + 1).some((o) => o.url === link)) {
      ctx.onTry?.(`pdf link → ${link}`);
      ordered.splice(i + 1, 0, { url: link, version: c.version, source: c.source, host: c.host, pdf: true });
    }
  }
  return miss(tier, reasons.join("; "));
}

// Whether a failure moves the paper on to the next browser stage: a refusal, a
// wall, a landing page without the article ("no article body (html, … words)",
// so worded since c4886f0 — the climb waited for the old "no methods/results"
// and stopped there until 2026-11-11: no browser, or no next browser, tried),
// content it cannot read; after a browser, any failure of that browser too.
// "not a pdf (…)" counts as what it wraps.
const CLIMB = /^(HTTP 403|HTTP 429|wall page|no article body|no methods\/results|unknown content)/;
export function climbsOn(reason: string, afterBrowser = false): boolean {
  const r = reason.replace(/^not a pdf \((.*)\)$/, "$1");
  return CLIMB.test(r) || (afterBrowser && /^(playwright|chrome|browser) /.test(r));
}

type Via = "plain" | { unlocker: string } | { browser: string; label: string } | { proxy: string; label: string };
const viaPrefix = (via: Via) => via === "plain" ? "" : "unlocker" in via ? `${via.unlocker}: ` : "proxy" in via ? `${fetchProxyName(via)}: ` : `${stageName({ kind: stageKind(via.browser), label: via.label })}: `;

// A failure reason without its stage prefix, for log lines that name the stage already.
const bare = (reason: string) => reason.replace(UNLOCKER_PREFIX, "").replace(STAGE_PREFIX, "");

// A failure carries the final URL (after redirects) when the fetch learned it,
// and the PDF link a landing page names (pdfUrl).
type Attempt = TierHit | { ok: false; reason: string; url?: string; pdfUrl?: string };
const reasonOf = (x: Attempt) => x.ok ? "" : x.reason;
async function tryOne(p: Paper, c: Candidate, tier: string, via: Via = "plain", signal?: AbortSignal): Promise<Attempt> {
  let got: { bytes: Buffer; contentType: string; url?: string };
  try {
    got = typeof via === "object" && "unlocker" in via ? await unlock(c.url, via.unlocker, signal)
        : typeof via === "object" ? ("proxy" in via ? await fetchBytes(c.url, { ...DOWNLOAD_HEADERS, ...(c.headers ?? {}) }, via.proxy, signal) : await browserFetch(c.url, via.browser, undefined, signal))
        : await fetchBytes(c.url, { ...DOWNLOAD_HEADERS, ...(c.headers ?? {}) }, undefined, signal);
  } catch (e) {
    // A configured service's error status comes with its own words: "HTTP 404 — 404 Not Found GET /…".
    const body = (e as { body?: string })?.body;
    if (c.service && body?.trim()) return { ok: false, reason: `${errMsg(e)} — ${serviceMessage(Buffer.from(body), (e as { contentType?: string }).contentType)}`, url: (e as { url?: string })?.url };
    return { ok: false, reason: viaPrefix(via) + errMsg(e), url: (e as { url?: string })?.url };
  }
  const { bytes, contentType } = got;
  // A configured service answers the paper as PDF or XML; any other body is
  // its error message, recorded as said ("service: Access denied for this IP").
  if (c.service && !looksLikePdf(bytes) && !isXmlArticle(bytes.toString("utf8"))) return { ok: false, reason: `service: ${serviceMessage(bytes, contentType)}`, url: got.url };
  // The unlocker answers 200 with an empty body when the target itself failed
  // (a 502 after its retries, typically a copy that is not open after all).
  if (typeof via === "object" && "unlocker" in via && !bytes.length) return { ok: false, reason: `${via.unlocker}: empty response` };
  const r = await convertBytes(p, bytes, contentType);
  // A copy thrown out as another document is said loudly: the check must stay rare (8 of 5,164 on live when it was
  // built, 2026-11-26) — a log with many of these lines means it throws out real full texts.
  if (!r.ok && r.refused) {
    log("add", p.pmid ? `pmid:${p.pmid}` : p.doi ? `doi:${p.doi}` : null, `!! full text refused as ${r.reason} — ${got.url ?? c.url} | it names the paper but holds no sentence of its abstract; if this line is frequent, the check is wrong (#7)`);
    return { ok: false, reason: r.reason, url: got.url };
  }
  if (!r.ok) return { ok: false, reason: c.pdf && r.format !== "pdf" ? `not a pdf (${r.reason})` : r.reason, url: got.url, pdfUrl: r.format === "html" ? pdfLink(bytes.toString("utf8"), got.url ?? c.url) : undefined };
  return { ok: true, tier, format: r.format, raw: r.format === "pdf" ? bytes : bytes.toString("utf8"), md: r.md, version: c.version };
}

// The PDF a landing page names: the citation_pdf_url meta tag (Highwire tags, used by
// publishers and repositories), else a repository's download link — figshare's
// ndownloader, DSpace's bitstream. Absolute, and not the page itself.
const META_PDF = /<meta\b(?=[^>]*\bname=["']citation_pdf_url["'])[^>]*\bcontent=["']([^"']+)["']/i;
const REPO_PDF = /href=["']([^"']*(?:\/ndownloader\/files\/\d+[^"']*|\/bitstreams?\/[^"']+\/download|\/bitstream\/handle\/[^"']+\.pdf[^"']*))["']/i;
export function pdfLink(html: string, pageUrl: string): string | undefined {
  const raw = META_PDF.exec(html)?.[1] ?? REPO_PDF.exec(html)?.[1];
  if (!raw) return undefined;
  try {
    const u = new URL(raw.replace(/&amp;/g, "&"), pageUrl);
    if (!/^https?:$/.test(u.protocol)) return undefined;
    return u.href === new URL(pageUrl).href ? undefined : u.href;
  } catch { return undefined; }
}

const isXmlArticle = (text: string) => /^\s*<\?xml|<article\b/.test(text.slice(0, 2000)) && !/<html/i.test(text.slice(0, 2000));
// The service's own words: a JSON "message"/"error", else the page's visible
// text, squashed and capped; an empty body says so.
export function serviceMessage(bytes: Buffer, contentType = ""): string {
  const text = bytes.toString("utf8").trim();
  if (!text) return `empty response (${contentType.split(";")[0] || "no type"})`;
  try { const j = JSON.parse(text); const m = j?.message ?? j?.error?.message ?? j?.error ?? j?.detail; if (typeof m === "string" && m.trim()) return m.trim().replace(/\s+/g, " ").slice(0, 160); } catch { /* not JSON */ }
  const visible = stripScripts(text).replace(/<title>([\s\S]*?)<\/title>/i, "$1. ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return (visible || text).slice(0, 160);
}

export type Converted = { ok: true; format: TierHit["format"]; md: string } | { ok: false; reason: string; format?: TierHit["format"]; refused?: true };   // refused: converted and checked, but another document (#7)

// Bytes of a copy (fetched or unlocked) → checked
// Markdown. The format is sniffed from the content, the Content-Type only
// breaks ties for HTML.
// A check failure in plain words, with what was actually seen: "no article
// body (html, 342 words, 2 headings)" is a landing page or a script shell,
// "title not in text (pdf, 1 page, 180 words)" is some other document.
function describe(reason: string, format: TierHit["format"], md: string): string {
  const words = md.split(/\s+/).filter(Boolean).length;
  const headings = md.split("\n").filter((l) => /^#{2,6}\s/.test(l)).length;
  const seen = `${format}, ${words} words, ${proseWords(md)} in prose, ${headings} heading${headings === 1 ? "" : "s"}`;
  if (reason === "no methods/results") return `no article body (${seen})`;
  if (reason === "title missing") return `neither title nor DOI in text (${seen})`;
  return reason;
}

// A document's Markdown source as the text to read: without its front matter, its comments (notes the page does
// not show), its own title line (ours stands above it) and empty HTML shells left for the site's build.
export function sourceMarkdown(text: string, ownTitle = false): string {
  let body = text.replace(/^\uFEFF/, "").replace(/^---\n[\s\S]*?\n---\n/, "");
  for (let prev = ""; prev !== body;) { prev = body; body = body.replace(/<!--[\s\S]*?-->/g, ""); }   // until none is left: removing one comment can join the halves of another
  const shown = body.replace(/^[ \t]*<(\w+)\b[^>]*>\s*<\/\1>[ \t]*$/gm, "");
  return (ownTitle ? shown : shown.replace(/^\s*# [^\n]*\n/, "")).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export async function convertBytes(p: Paper, bytes: Buffer, contentType = ""): Promise<Converted> {
  let format: TierHit["format"];
  let md: string;
  if (looksLikePdf(bytes)) {
    format = "pdf";
    const stats: { pages?: number; chars?: number } = {};
    try { md = await pdfToMarkdown(bytes, p.title, p.headLine, stats); } catch (e) { return { ok: false, reason: `pdf: ${errMsg(e)}` }; }
    // Page images with no text layer (a printed page holds 2000–5000 characters;
    // a scan's layer, if any, is the title block). Nothing to convert, and OCR
    // output would not serve the model either.
    if ((stats.pages ?? 0) >= 1 && (stats.chars ?? 0) < 500 * (stats.pages ?? 1)) return { ok: false, reason: "scanned pdf", format };
  } else {
    const text = bytes.toString("utf8");
    if (isWallPage(text)) return { ok: false, reason: "wall page" };
    if (/^\s*<\?xml|<article\b/.test(text.slice(0, 2000)) && /<body\b/.test(text) && !/<html/i.test(text.slice(0, 2000))) {
      format = "xml";
      const doc = parseJats(/full-text-retrieval-response/.test(text.slice(0, 3000)) ? elsevierToJats(text) : text);
      if (!doc.title) doc.title = p.title;
      if (!doc.hasBody) return { ok: false, reason: "xml without body" };
      md = renderFulltextMd(doc, p.headLine);
    } else if (/text\/(x-)?markdown/i.test(contentType) && !/<html|<!doctype html/i.test(text.slice(0, 500))) {
      // The document's own Markdown source (a page names it: <link rel="alternate" type="text/markdown">, src/tiers/doilink.ts).
      format = "md";
      md = `# ${p.title}\n\n${p.headLine}\n\n${sourceMarkdown(text)}`;
    } else if (/text\/html|<html/i.test(contentType + text.slice(0, 500))) {
      format = "html";
      const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text)?.[1] ?? text;
      md = `# ${p.title}\n\n${p.headLine}\n\n${htmlToMarkdown(body)}`;
    } else {
      return { ok: false, reason: `unknown content (${contentType.split(";")[0] || "no type"})` };
    }
  }
  // The checks run on the converted content WITHOUT the "# <title>" heading the
  // converters prepend from PubMed's title — otherwise the title check would
  // always pass and any document would count as this paper.
  // JATS carries the paper's own title, and so does a Markdown source: checked with its own title line, not ours.
  const content = format === "xml" ? md : format === "md" ? `${p.headLine}\n\n${sourceMarkdown(bytes.toString("utf8"), true)}` : md.replace(/^# [^\n]*\n/, "");
  // HTML: the title may sit in a <header> or <title> the converter drops — look in the raw page text too.
  const rawText = format === "html" ? stripTags(stripScripts(bytes.toString("utf8")), " ") : undefined;
  // A Markdown source, like a PDF, is a document and not a page about one: the title at its start and an article's prose, headings as they are.
  const check = checkFulltext(content, p.title, rawText, p.doi, format === "xml", format === "pdf" || format === "md");
  if (!check.ok) return { ok: false, reason: describe(check.reason, format, content), format };
  // It names the paper — but is it the paper? No sentence of the abstract in it: its supplement, or another document (#7).
  const body = content.startsWith(p.headLine) ? content.slice(p.headLine.length) : content.replace(p.headLine, "");
  // Not for XML: a publisher's or PMC's structured article for this ID is the article (all eight found were PDFs; PNAS gives
  // PubMed its Significance statement as the abstract, which the article's XML does not hold — pmid:35286195).
  const other = format === "xml" ? null : anotherDocument(body, p.title, p.abstract);
  if (other) return { ok: false, reason: `${other} (${format}, ${content.split(/\s+/).filter(Boolean).length} words, no sentence of the abstract)`, format, refused: true };
  return { ok: true, format, md };
}

// Elsevier's full-text XML (ja:/ce: namespaces) uses its own element names for
// the same structure JATS has. Renaming the structural elements lets the JATS
// converter render it: sections, paragraphs, inline markup, lists, tables.
const ELSEVIER_TAGS: [RegExp, string][] = [
  [/ja:article\b/g, "article"], [/ja:body\b/g, "body"], [/ja:head\b/g, "front"],
  [/ce:sections\b/g, "sec-group"], [/ce:section-title\b/g, "title"], [/ce:section\b/g, "sec"],
  [/ce:simple-para\b/g, "p"], [/ce:para\b/g, "p"], [/ce:abstract-sec\b/g, "sec"], [/ce:abstract\b/g, "abstract"],
  [/ce:title\b/g, "article-title"], [/ce:italic\b/g, "italic"], [/ce:bold\b/g, "bold"], [/ce:sup\b/g, "sup"], [/ce:inf\b/g, "sub"],
  [/ce:cross-refs?\b/g, "xref"], [/ce:list-item\b/g, "list-item"], [/ce:list\b/g, "list"], [/ce:label\b/g, "label"],
  [/ce:caption\b/g, "caption"], [/ce:table\b/g, "table-wrap"], [/ce:figure\b/g, "fig"],
  [/ce:bib-reference\b/g, "ref"], [/ce:bibliography\b/g, "ref-list"], [/sb:reference\b/g, "mixed-citation"],
  [/ce:acknowledgment\b/g, "ack"], [/ce:inter-ref\b/g, "ext-link"],
];

export function elsevierToJats(xml: string): string {
  let out = xml;
  for (const [re, to] of ELSEVIER_TAGS) out = out.replace(re, to);
  // Drop the retrieval envelope so <article> is reachable; keep what is inside.
  return out.replace(/<\/?full-text-retrieval-response[^>]*>/g, "").replace(/<\/?originalText[^>]*>/g, "").replace(/<\/?xocs:doc[^>]*>/g, "").replace(/<\/?xocs:serial-item[^>]*>/g, "");
}

// ---- Design notes: Multi-stage download (fetch → browser → unlockers) ----
//
// Mirrors the URL verification cascade of AI4L-based review pipelines (`d-browser` → `d-fetch` → `d-proxy-1` residential Playwright → `d-proxy-2` Bright Data):
//
// | step | here | notes |
// |---|---|---|
// | fetch | Node fetch from this host (no browser, no cookies, no JavaScript) | desktop Chrome UA; the only stage that carries token headers (tdm) |
// | fetch-proxy | the `FH_FETCH_PROXY` host (`http://host:8888` internally): the same fetch through an HTTP forward proxy (`utilities/fetch-proxy/`, tinyproxy; undici's `ProxyAgent`), so it leaves from that host's IP | on every failed fetch, with its headers (tokens too; the proxy only tunnels TLS), not for a configured service; the later stages still go by what the plain fetch met; Cloudflare and Turnstile still refuse it (TLS fingerprint), the browsers' job |
// | playwright × N | `src/browser.ts`, `chromium.connect()` to each `FH_PLAYWRIGHT_n` host (`ws://host:8932` internally; `utilities/playwright/` = the container: Microsoft's Playwright image, `playwright-core run-server` under Xvfb, port 8932) | headed via the server's Xvfb (clears Cloudflare "Just a moment" for Wiley, Karger…); stage 1 next to the server (data-centre IP), stage 2 on home-box (residential line; both deployed by `utilities/deploy.sh` as `evidence-playwright-server-9300`, published on the tailnet IP). The server must run the package's exact `playwright-core` (428 otherwise, said in words as an alert) |
// | chrome × N | each `FH_CHROME_n` host (`cdp://host:9222` internally): a real Google Chrome with `--remote-debugging-port`, attached with `connectOverCDP`, its default profile; `utilities/chrome/chrome.sh` starts it, `utilities/chrome/chrome.md` explains it; on this VM `127.0.0.1`, the `fh-chrome` user service | Google Chrome brand, real GPU, cookies that persist — the strongest stage, after the Playwright servers so the desktop takes only the residue |
// | firecrawl | Firecrawl Cloud `/v2/scrape`, rawHtml, parsers [] (a PDF as its bytes), proxy auto | |
// | zenrows | ZenRows Fetch, `mode=auto` | |
// | zyte | Zyte API `/v1/extract`, httpResponseBody | |
// | brightdata | Bright Data Web Unlocker, `/request` | zone IP lists (a denylist answers 200 + x-brd-error) |
//
// The package never downloads or launches a browser itself (the in-process "local" stage was dropped 2026-11-08: every stage is a browser somebody runs). No anti-detection flags are used, by decision.
//
// The evaluations of the services and stages (results, decisions, live observations): stuff/unlock/unlockers.md.
//
// A review pipeline's residential egress (Playwright MCP on :8931, tinyproxy on :3128) is not used as such: the MCP returns snapshots, not bytes. Its idea is: the fetch-proxy stage (2026-11-10) is the same tinyproxy, lending the residential IP to the plain fetch — a fetch's speed for what is walled by IP alone, before any browser.
//
