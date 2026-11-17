import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { daysSince, today, writeAtomic } from "./entry.js";
import { FH_EVIDENCE_DIR } from "./layout.js";
import { searchCacheDays, searchFile } from "./trials.js";

// fh_web_search: a web search, optionally restricted to sites — where a
// site's own search page fails (script-rendered: an empty page shell, "search
// could not finish") and a model's built-in search drops a domain filter
// (Opus 5.5: 440 of 720 results off-site). Exa, chosen on
// stuff/bench/search-engines.md (#73): most relevant on-site hits of seven
// providers (437 of 72 searches, 6 empty), the smallest answers (~700 tokens).
// Offered only when a provider is configured (FH_WEB_SEARCH_*); without one the
// server registers no tool and agents use their model's own search. Internal
// for now: not in the README or .env.example.
//   POST https://api.exa.ai/search {query, includeDomains?}  x-api-key
// Rows: title, URL, published date, author and a short snippet (snippetsOn) —
// what an agent needs to pick a page to read with fh_fetch_url. Cached under search/ for FH_SEARCH_CACHE_DAYS.

// Each provider is asked once per search, without a count: it returns what it
// gives by default (2026-11-16: Exa 10, Serper 10, Brave 20 — each its most at the
// base price). The merged list, each page once, is the answer — whole, or its
// first max_results; for more, the model searches again with other words.
export type Query = { query: string; sites?: string[]; max_results?: number };   // max_results: fewer rows; unset, all
export const COLUMNS = ["title", "url", "published", "author", "snippet"] as const;
export type Row = [string, string, string | null, string | null, string | null];

// A snippet per row (FH_WEB_SEARCH_SNIPPETS=on, the default): the provider's
// passage matching the query, cut to ~220 characters — Exa's highlight, no
// extra request or cost; off: links only. A general setting, not one provider's:
// every search provider returns a passage per hit or none. Measured on 8
// searches (2026-11-16, #73): links ~1,500 characters, with snippets ~4,100; the
// built-in search's results cost 12–19k tokens.
export const snippetsOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(off|false|no|0)$/i.test((env.FH_WEB_SEARCH_SNIPPETS ?? "").trim());
export const SNIPPET_CHARS = 220;

// A page's furniture at the start of a passage ("• Last Updated: September 10, 2026",
// "Written by: …") is not what it says: dropped; the rest cut at a word near SNIPPET_CHARS.
export function cleanSnippet(t: string | null | undefined): string | null {
  let s = (t ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:[#•*\-\s]*(?:last updated|updated|published|written by|reviewed by|by)\b[^.]*?(?:\d{4}|others)\s*)+/i, "").trim();
  s = s.replace(/^#+\s*/, "").replace(/^[·•\s]*(?:Cited by \d+|\d+ (?:days?|hours?) ago|[A-Z][a-z]{2} \d{1,2}, \d{4})\s*[—–-]\s*/i, "");   // Google's "· Cited by 320 —", "Sep 10, 2026 —"
  if (!s) return null;
  if (s.length <= SNIPPET_CHARS) return s;
  const cut = s.slice(0, SNIPPET_CHARS);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), SNIPPET_CHARS - 40)).replace(/[,;:\s]+$/, "") + " …";
}
export type Result = { source: SearchProviderName; query: Query; total: number; columns: typeof COLUMNS; rows: Row[]; searched: string };
// The merged answer: the rows, and per provider how many it gave (or why none)
export type Merged = { total: number; columns: typeof COLUMNS; rows: Row[]; providers: Record<string, number | string>; query: Query };

// The providers: every one with a key takes part, as the unlockers do
// (src/unlock.ts) — FH_WEB_SEARCH_EXA_API_KEY, _SERPER_API_KEY, _BRAVE_API_KEY.
// Development only: nothing unless FH_WEB_SEARCH_ENABLED is true (default false).
// No key: no web search, the tool is not offered. They are asked at once and
// their answers merged: on the bench (stuff/bench/search-engines.md, #73) Exa
// alone found 437 distinct relevant pages, the three together 744.
export const SEARCH_PROVIDERS = ["exa", "serper", "brave"] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];
export type WebSearchConfig = { provider: SearchProviderName; key: string };
export const webSearchEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(true|1|yes|on)$/i.test(env.FH_WEB_SEARCH_ENABLED?.trim() ?? "");
export function webSearchConfig(env: NodeJS.ProcessEnv = process.env): WebSearchConfig[] {
  if (!webSearchEnabled(env)) return [];
  return SEARCH_PROVIDERS.flatMap((provider) => { const key = env[`FH_WEB_SEARCH_${provider.toUpperCase()}_API_KEY`]?.trim(); return key ? [{ provider, key }] : []; });
}
export const webSearchConfigured = (env: NodeJS.ProcessEnv = process.env): boolean => webSearchConfig(env).length > 0;

// "https://www.nih.gov/health-information/" → "nih.gov"; a bare domain stays.
export function siteDomain(site: string): string | null {
  const s = site.trim().toLowerCase().replace(/^site:/, "");
  if (!s) return null;
  try { return new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, "") || null; } catch { return null; }
}

// The query exactly as for a model's built-in web search: "metformin site:nih.gov",
// several sites "statins (site:nih.gov OR site:who.int)". The site: terms (and the
// OR / brackets joining them) leave the text and restrict the search to those
// domains; the rest is the query.
export function normalizeQuery(q: { query?: string; max_results?: number }): Query | { error: string } {
  let query = (q.query ?? "").replace(/\s+/g, " ").trim();
  const sites: string[] = [];
  for (const m of query.matchAll(/(?:^|[\s(])site:([^\s()]+)/gi)) {
    const d = siteDomain(m[1]);
    if (!d) return { error: `site: needs a domain like "nih.gov", not "${m[1]}"` };
    if (!sites.includes(d)) sites.push(d);
  }
  if (sites.length) {
    query = query.replace(/site:[^\s()]+/gi, " ")
      .replace(/\(\s*(?:OR\s*)*\)/gi, " ")          // "( OR )" left by the sites
      .replace(/(?:^|\s)OR(?=\s*(?:$|\)))/g, " ")   // a trailing OR
      .replace(/(?:^|\s)OR\s+(?=OR\b)/g, " ")       // OR OR
      .replace(/\s+/g, " ").trim().replace(/^OR\s+|\s+OR$/g, "");
  }
  if (!query) return { error: "empty query" };
  const out: Query = { query };
  if (q.max_results && q.max_results >= 1) out.max_results = Math.floor(q.max_results);
  if (sites.length) out.sites = sites;
  return out;
}

export const searchKey = (q: Query, provider: SearchProviderName = "exa", snippets = snippetsOn()) => createHash("sha1").update(JSON.stringify(["web", provider, snippets ? "snippets" : "links", q.query.toLowerCase(), q.sites ?? []])).digest("hex").slice(0, 16);

// "Sep 10, 2026", "2026-09-10T00:30:05" → "2026-09-10"; a relative age ("3 days ago") → null.
export function isoDay(d: unknown): string | null {
  const t = String(d ?? "").trim();
  if (!t || /\bago\b/i.test(t)) return null;
  if (/^\d{4}-\d\d-\d\d/.test(t)) return t.slice(0, 10);
  const day = new Date(t);   // "Sep 10, 2026": parsed as local midnight, so the local date parts
  return Number.isFinite(day.getTime()) ? `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}` : null;
}
// Google's tracking parameter on Serper's links
const stripTracking = (u: string) => u.replace(/([?&])srsltid=[^&]*&?/, "$1").replace(/[?&]$/, "");
const plain = (t: string | null | undefined) => (t ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
// site: terms for the providers that take them in the query text (Serper, Brave)
const withSites = (q: Query) => !q.sites ? q.query : q.sites.length === 1 ? `${q.query} site:${q.sites[0]}` : `${q.query} (${q.sites.map((d) => `site:${d}`).join(" OR ")})`;

type ExaResult = { title?: string | null; url?: string; publishedDate?: string | null; author?: string | null; highlights?: string[] };
export function parseExa(json: string): Row[] {
  const d = JSON.parse(json) as { results?: ExaResult[] };
  return (d.results ?? []).filter((x) => x.url).map((x) => [
    (x.title ?? "").replace(/\s+/g, " ").trim(),
    x.url!,
    x.publishedDate ? x.publishedDate.slice(0, 10) : null,
    x.author ? x.author.replace(/\s+/g, " ").trim() : null,
    cleanSnippet(x.highlights?.[0]),
  ]);
}
type SerperResult = { title?: string; link?: string; snippet?: string; date?: string };
export function parseSerper(json: string): Row[] {
  const d = JSON.parse(json) as { organic?: SerperResult[] };
  return (d.organic ?? []).filter((x) => x.link).map((x) => [plain(x.title).replace(/\s+/g, " ").trim(), stripTracking(x.link!), isoDay(x.date), null, cleanSnippet(plain(x.snippet))]);
}
type BraveResult = { title?: string; url?: string; description?: string; page_age?: string; age?: string };
export function parseBrave(json: string): Row[] {
  const d = JSON.parse(json) as { web?: { results?: BraveResult[] } };
  return (d.web?.results ?? []).filter((x) => x.url).map((x) => [plain(x.title).replace(/\s+/g, " ").trim(), x.url!, isoDay(x.page_age ?? x.age), null, cleanSnippet(plain(x.description))]);
}

// An HTTP call: POST with a JSON body, or GET when body is undefined.
export type Post = (url: string, body: unknown, headers: Record<string, string>) => Promise<string>;
// FH_WEB_SEARCH_TIMEOUT_SECS (default 10): how long one provider may take — normally
// 1–3 s, the slowest seen 6.6 s; past it the search answers with the others.
export const searchTimeoutSecs = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.FH_WEB_SEARCH_TIMEOUT_SECS);
  return Number.isFinite(n) && n > 0 ? n : 10;
};
const live: Post = async (url, body, headers) => {
  const signal = AbortSignal.timeout(searchTimeoutSecs() * 1000);
  let r: Response;
  try {
    r = await fetch(url, body === undefined
      ? { headers: { accept: "application/json", ...headers }, signal }
      : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) { throw signal.aborted ? new Error(`timeout ${searchTimeoutSecs()}s`) : e; }
  const text = await r.text();
  if (!r.ok) {
    let why = ""; try { const j = JSON.parse(text) as { error?: string | { detail?: string }; message?: string }; why = (typeof j.error === "string" ? j.error : j.error?.detail) ?? j.message ?? ""; } catch { why = text.slice(0, 120); }
    throw new Error(`HTTP ${r.status}${why ? `: ${why}` : ""}`);
  }
  return text;
};

// One request to the provider, its answer as rows. Exa restricts by includeDomains,
// Serper and Brave by site: in the query (both keep it: stuff/bench/search-engines.md).
const SEARCH: Record<SearchProviderName, (q: Query, key: string, post: Post) => Promise<Row[]>> = {
  exa: async (q, key, post) => parseExa(await post("https://api.exa.ai/search", {
    query: q.query, ...(q.sites ? { includeDomains: q.sites } : {}),
    ...(snippetsOn() ? { contents: { highlights: { query: q.query, numSentences: 2, highlightsPerUrl: 1 } } } : {}),
  }, { "x-api-key": key })),
  serper: async (q, key, post) => parseSerper(await post("https://google.serper.dev/search", { q: withSites(q) }, { "X-API-KEY": key })),
  brave: async (q, key, post) => parseBrave(await post(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: withSites(q) })}`, undefined, { "X-Subscription-Token": key })),
};

export type Outcome = { ok: true; result: Merged; cached: boolean } | { ok: false; error: string; input?: true };   // input: the caller's mistake, logged as error; else failed

// One provider's answer: from the cache for FH_SEARCH_CACHE_DAYS, else asked.
export type SearchEvent = (line: string) => void;
// The same search asked again while it runs (pages requested at once): one request, shared
const inFlight = new Map<string, Promise<{ rows: Row[]; cached: boolean }>>();
function oneProvider(q: Query, cfg: WebSearchConfig, libraryDir: string, post: Post, onEvent?: SearchEvent): Promise<{ rows: Row[]; cached: boolean }> {
  const file = searchFile(libraryDir, searchKey(q, cfg.provider));
  const running = inFlight.get(file);
  if (running) return running;
  const p = askProvider(q, cfg, libraryDir, post, onEvent).finally(() => inFlight.delete(file));
  inFlight.set(file, p);
  return p;
}
async function askProvider(q: Query, cfg: WebSearchConfig, libraryDir: string, post: Post, onEvent?: SearchEvent): Promise<{ rows: Row[]; cached: boolean }> {
  const file = searchFile(libraryDir, searchKey(q, cfg.provider));
  if (existsSync(file)) {
    try { const r = JSON.parse(readFileSync(file, "utf8")) as Result; if (daysSince(r.searched) < searchCacheDays()) return { rows: r.rows, cached: true }; } catch { /* half a file is no file */ }
  }
  // As the download cascade: "try <provider>", then one closing line, ok or failed
  onEvent?.(`try ${cfg.provider}`);
  const t0 = Date.now();
  let rows: Row[];
  try { rows = (await SEARCH[cfg.provider](q, cfg.key, post)).filter((r) => !q.sites || q.sites.some((d) => siteDomain(r[1])?.endsWith(d))); }
  catch (e) { onEvent?.(`failed ${cfg.provider}: ${e instanceof Error ? e.message : String(e)}`); throw e; }
  onEvent?.(`ok ${cfg.provider} ${((Date.now() - t0) / 1000).toFixed(1)}s rows=${rows.length}`);
  const result: Result = { source: cfg.provider, query: q, total: rows.length, columns: COLUMNS, rows, searched: today() };
  try { mkdirSync(dirname(file), { recursive: true }); writeAtomic(file, JSON.stringify(result, null, 2) + "\n"); } catch { /* the cache is a courtesy */ }
  return { rows, cached: false };
}

// The same page from several providers is one row: pages more providers found come
// first (the strongest sign of relevance), then by their best rank; a field one
// provider left empty is filled from another.
const pageKey = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
export function mergeRows(lists: Row[][]): Row[] {
  const pages = new Map<string, { row: Row; hits: number; best: number }>();
  for (const rows of lists) rows.forEach((r, i) => {
    const k = pageKey(r[1]); const p = pages.get(k);
    if (!p) { pages.set(k, { row: [...r] as Row, hits: 1, best: i }); return; }
    p.hits++; p.best = Math.min(p.best, i);
    for (const f of [2, 3, 4] as const) p.row[f] ??= r[f];
  });
  return [...pages.values()].sort((a, b) => b.hits - a.hits || a.best - b.best).map((p) => p.row);
}

export async function webSearch(raw: { query?: string; max_results?: number }, libraryDir = FH_EVIDENCE_DIR, post: Post = live, cfgs: WebSearchConfig[] = webSearchConfig(), onEvent?: SearchEvent): Promise<Outcome> {
  if (!cfgs.length) return { ok: false, error: "web search not configured" };
  const q = normalizeQuery(raw);
  if ("error" in q) return { ok: false, error: q.error, input: true };
  const answers = await Promise.allSettled(cfgs.map((c) => oneProvider(q, c, libraryDir, post, onEvent)));
  const providers: Record<string, number | string> = {};
  const lists: Row[][] = []; let allCached = true;
  answers.forEach((a, i) => {
    const name = cfgs[i].provider;
    if (a.status === "fulfilled") { providers[name] = a.value.rows.length; lists.push(a.value.rows); allCached &&= a.value.cached; }
    else providers[name] = a.reason instanceof Error ? a.reason.message : String(a.reason);
  });
  if (!lists.length) return { ok: false, error: Object.entries(providers).map(([n, e]) => `${n}: ${e}`).join("; ") };
  const all = mergeRows(lists);   // the cache key leaves max_results out: a cap only cuts the same list
  return { ok: true, result: { total: all.length, columns: COLUMNS, rows: all.slice(0, q.max_results), providers, query: q }, cached: allCached };
}
