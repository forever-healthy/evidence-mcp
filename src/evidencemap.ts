import { storeCharacteristics } from "./characteristics.js";
import { num } from "./env.js";
import { openEvid } from "./evid.js";
import { fetchArticles, MAX_PMIDS } from "./pubmedbatch.js";
import { esearchUrl, normalizeQuery, parseEsearch, searchArticles, searchKey, type Result as SearchResult } from "./pubmedsearch.js";
import { searchFile, searchCacheDays } from "./trials.js";
import { daysSince, today, writeAtomic } from "./entry.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fetchText } from "./http.js";
import { existsSync, readFileSync } from "node:fs";
import { entryPaths } from "./layout.js";
import { askFor, type Ask, cacheKey, SCREEN_PROVIDERS, type ScreenProvider, FIELDS, score, screenAll, screenConfig, screenLine, screenParallel, type Screened, type ScreenResult, scoreTitleOnly, where } from "./screen.js";
import { log } from "./log.js";
import { poolKeys, sharedPool } from "./keypool.js";
import { activePrompt } from "./prompts.js";
import { citationCounts, perYear } from "./citecount.js";
import { inclusionCounts, referencedPmids } from "./citesearch.js";
import { lastRun, metaOf, openDb, query, type Rows, storedQueries } from "./evmapdb.js";

// fh_evmap_create_map (#78, development only: FH_EVMAP_ENABLED) — the
// evidence map for an EVID (stuff/evmap/architecture.md). The server is an
// engine: the caller brings the queries and the screening prompt (samples in
// evmap/). The screening prompt's convention: {{topic}} — the server puts in the
// EVID's metadata topic; {{article}} — the server puts in each paper (PMID, title,
// year, publication types, abstract).
//
// Stages (concept: Stages 2–5): each query runs (PubMed's relevance order, at most
// FH_EVMAP_MAX_RESULTS_PER_QUERY rows), the rows are merged, every paper goes
// into the library at abstract level (the batch path, 200 PMIDs per request),
// retracted papers are dropped; then a model screens each abstract (src/screen.ts,
// FH_EVMAP_SCREENING_API_KEY; without a key the screening is skipped), off-topic
// papers are dropped and the rest ranked by score; citation searching
// follows. Everything is stored in the EVID's evidence map database (src/evmapdb.ts,
// evmap/evmap.db): queries and their hits, articles with screening and score, one row
// per run — no EVID objects.

export const evidenceMapEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(true|1|yes|on)$/i.test(env.FH_EVMAP_ENABLED?.trim() ?? "");
// New queries per call (queries the EVID already ran do not count): a query costs at most 500
// abstracts to screen, ~$0.12 and a few seconds at 400 at once (stuff/evmap/screening/screening.md).
// Measured 2026-11-21, 12 fresh queries: 1 at a time 28 s, 3 20 s, 6 12 s, 10 8.4 s at ~4 requests a
// second (each request ~0.7 s), none refused — 10 at a time; a refused request retries once.
// Without an NCBI key NCBI allows 3 a second: 2 at a time.
const PREFILL_PARALLEL = 4;
const searchParallel = (env: NodeJS.ProcessEnv = process.env): number => (env.FH_NCBI_API_KEY?.trim() ? 10 : 2);
export const maxResultsPerQuery = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_MAX_RESULTS_PER_QUERY", 500, env, (n) => n >= 1 && n <= 1000 && Number.isInteger(n));

export const COLUMNS = ["pmid", "title", "first_author", "year", "journal", "types", "score", "signals", "relevance", "population", "design", "n", "outcome", "finding", "aspect", "reason"] as const;

export const SLOTS = ["{{topic}}", "{{article}}"] as const;

type Fail = { ok: false; error: string; failed?: true };   // failed: not the caller's mistake (the server's settings, a service)

const SETTINGS = "FH_EVMAP_SCREENING_PROVIDER, FH_EVMAP_SCREENING_API_KEY, FH_EVMAP_SCREENING_MODEL, FH_EVMAP_SCREENING_URL";
export type Screener = { ok: true; ask: Ask; model: string; where: string; keys?: () => string } | { ok: false; reason: string };   // keys: the calls per key of the pool, when there is one

// The stages' outside calls, replaceable in tests.
export type Deps = {
  search: (query: string, max: number) => Promise<{ ok: true; total: number; rows: (string | null)[][]; cached?: boolean } | Fail>;
  prefill: (pmids: string[]) => Promise<{ pmid: string; retracted: boolean | null; level: string; title?: string | null; first_author?: string | null; year?: string | null; journal?: string | null; types?: string | null }[]>;
  screener: Screener;   // the screening model, or why there is none
  paper: (pmid: string) => string | null;   // the text for {{article}}
  cites: (pmids: string[]) => Promise<{ counts: Map<string, number>; failed: number; error?: string }>;   // OpenAlex citation counts
  refs: (reviews: string[]) => Promise<{ refs: Map<string, string[]>; failed: number }>;   // OpenAlex reference lists, review → PMIDs
  log: (id: string, message: string) => void;   // a line of evidence.log, tool evmap
  retryMs?: number;   // the pause before a failed pre-fill request is tried again (tests: 0)
};

// One pre-fill request that does not end the build (PubMed answers HTTP 400 now and then, #101):
// tried again after a pause; then in halves, to find an ID PubMed refuses — as long as one half
// answers (both failing is an outage: no more requests). lost: the PMIDs without an answer.
type Prefilled = Awaited<ReturnType<Deps["prefill"]>>;
export async function prefillBatch(deps: Deps, pmids: string[]): Promise<{ rows: Prefilled; lost: string[]; error?: string }> {
  const attempt = async (b: string[]) => { try { return { rows: await deps.prefill(b) }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } };
  let r = await attempt(pmids);
  if (r.rows) return { rows: r.rows, lost: [] };
  await new Promise((done) => setTimeout(done, deps.retryMs ?? 2000));
  r = await attempt(pmids);
  if (r.rows) return { rows: r.rows, lost: [] };
  const error = r.error;
  const split = async (b: string[]): Promise<{ rows: Prefilled; lost: string[] }> => {
    if (b.length < 2) return { rows: [], lost: b };
    const halves = [b.slice(0, b.length >> 1), b.slice(b.length >> 1)];
    const [x, y] = [await attempt(halves[0]), await attempt(halves[1])];
    if (!x.rows && !y.rows) return { rows: [], lost: b };
    const out = { rows: [] as Prefilled, lost: [] as string[] };
    for (const [k, h] of [x, y].entries()) {
      const part = h.rows ? { rows: h.rows, lost: [] } : await split(halves[k]);
      out.rows.push(...part.rows); out.lost.push(...part.lost);
    }
    return out;
  };
  return { ...await split(pmids), error };
}

export const live = (lib: string): Deps => ({
  search: async (query, max) => {
    return bigSearch(lib, query, max);   // one request, the IDs — for a few results too
  },
  prefill: async (pmids) => (await fetchArticles(pmids, lib)).rows.map((r) => ({ pmid: r[0], retracted: r[5], level: r[6], title: r[1], first_author: r[2], year: r[3], journal: journalOf(lib, r[0]), types: r[4] })),
  screener: (() => {
    const c = screenConfig();
    if (!c.ok) return { ok: false, reason: c.reason };
    const keys = poolKeys();
    if (!keys.length) return { ok: true, ask: askFor(c), model: c.model, where: where(c) };
    const pool = sharedPool(c, keys, (line) => log("evmap", null, line));
    return { ok: true, ask: pool.ask, model: c.model, where: where(c), keys: pool.counts };
  })(),
  paper: (pmid) => { const f = entryPaths(lib, "pmid", pmid).md; return existsSync(f) ? readFileSync(f, "utf8") : null; },
  cites: (pmids) => citationCounts(pmids),
  refs: (reviews) => referencedPmids(reviews),
  log: (id, message) => log("evmap", id, message),
});

// The journal of a stored article, as PubMed abbreviates it ("N Engl J Med"), from its stored
// record: the batch fetch's rows do not carry it.
const unesc = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
export function journalOf(lib: string, pmid: string): string | null {
  try {
    const xml = readFileSync(entryPaths(lib, "pmid", pmid).xml, "utf8");
    const m = /<ISOAbbreviation>([^<]+)<\/ISOAbbreviation>/.exec(xml) ?? /<MedlineTA>([^<]+)<\/MedlineTA>/.exec(xml) ?? /<Journal>[\s\S]*?<Title>([^<]+)<\/Title>/.exec(xml);
    return m ? unesc(m[1]).trim() || null : null;
  } catch { return null; }
}

// A query's search: one request, the IDs in PubMed's order (esearch). Title, author,
// year, journal and types come from the library pre-fill that follows, which fetches every
// article's record anyway — no summaries request (before 2026-11-22: esummary in batches of 200,
// up to 4 requests a query against NCBI's 10 a second). A row is [pmid]; a cache file written
// before, with full rows, reads the same. Same cache folder as fh_pubmed_search_articles
// (search/), the shared search code left as it is.
async function bigSearch(lib: string, query: string, max: number): Promise<{ ok: true; total: number; rows: (string | null)[][]; cached?: boolean } | Fail> {
  const q = normalizeQuery({ query, max_results: max }, max);
  if ("error" in q) return { ok: false, error: q.error };
  const file = searchFile(lib, searchKey(q));
  if (existsSync(file)) {
    try { const r = JSON.parse(readFileSync(file, "utf8")) as SearchResult; if (daysSince(r.searched) < searchCacheDays()) return { ok: true, total: r.total, rows: r.rows, cached: true }; } catch { /* half a file is no file */ }
  }
  try {
    const { total, ids } = parseEsearch(await fetchText(esearchUrl(q), { "User-Agent": "evidence-mcp", Accept: "application/json" }));
    const rows: (string | null)[][] = ids.map((id) => [id]);
    const result = { source: "pubmed", query: q, total, columns: ["pmid"], rows, searched: today() };
    try { mkdirSync(dirname(file), { recursive: true }); writeAtomic(file, JSON.stringify(result) + "\n"); } catch { /* the cache is a courtesy */ }
    return { ok: true, total, rows };
  } catch (e) { return { ok: false, error: `pubmed: ${e instanceof Error ? e.message : String(e)}` }; }
}

export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Paper = { pmid: string; title: string | null; first_author: string | null; year: string | null; journal: string | null; types: string | null; queries: number[]; reviews?: number };

// Backward citation searching: the reference lists of the map's top K reviews (meta-analyses,
// systematic reviews) after the first screening; at most FROM_REVIEWS new articles, those
// included by the most reviews first. FH_EVMAP_CITATION_REVIEWS=0 turns it off.
export const reviewCount = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_CITATION_REVIEWS", 10, env, (n) => n >= 0 && n <= 50 && Number.isInteger(n));
export const maxFromReviews = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_CITATION_MAX_ADDED", 300, env, (n) => n >= 0 && n <= 2000 && Number.isInteger(n));
const REVIEW = /meta-analy|systematic review/i;

export async function doResearch(lib: string, evid: string, queries: string[], screeningArg: string | undefined, env: NodeJS.ProcessEnv = process.env, now: Date = new Date(), deps: Deps = live(lib), limits?: Record<string, number>): Promise<{ ok: true; evid: string; included: number; failed_queries?: { query: string; error: string }[]; empty_queries?: string[]; screening_errors?: number; first_error?: string; note?: string; citations_error?: string; already_run?: number } | Fail> {
  const o = openEvid(lib, evid);
  if (!o.ok) return o;
  // The prompts: the project's (the folder FH_EVMAP_PROMPTS) or the built-in ones (evmap/*.md);
  // a folder or file that cannot be used stops the map. screeningArg only for the bench and the tests.
  const ps = activePrompt("screening", env);
  for (const x of screeningArg?.trim() ? [] : [ps]) if (x.problem) return { ok: false, failed: true, error: `prompts: ${x.problem}. Nothing ran. It is set in the server's .env by whoever runs the server.` };
  const screening = screeningArg?.trim() ? screeningArg : ps.text;
  const missing = SLOTS.filter((p) => !screening.includes(p));
  if (missing.length) return { ok: false, error: `screening: the prompt needs ${missing.join(" and ")} (sample: evmap/screening.md)` };
  const topic = o.metadata.topic;
  if (typeof topic !== "string" || !topic.trim()) return { ok: false, error: `${o.evid}: the metadata has no topic for {{topic}}` };
  const fresh = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
  if (!fresh.length) return { ok: false, error: "queries: at least one PubMed query" };
  // Incremental: the EVID's database keeps every query run for it; this call's new ones are added,
  // the old ones run again from the search cache, and only new articles cost screening. A query
  // sent again is not an error: it is skipped and counted (already_run).
  const db = openDb(o.dir);
  const stored = storedQueries(db);
  // How many results each query reads: the general maximum, or the query's own (limits: an item's query of the
  // discovery reads PubMed's first few — a narrow question's answer is on its first page); remembered with the query.
  const ownMax = new Map<string, number>((db.prepare("SELECT query, max_results FROM queries WHERE max_results IS NOT NULL").all() as { query: string; max_results: number }[]).map((x) => [x.query, x.max_results]));
  for (const [q, n] of Object.entries(limits ?? {})) ownMax.set(q.replace(/\s+/g, " ").trim(), n);
  const added = fresh.filter((q) => !stored.includes(q));
  const alreadyRun = fresh.length - added.length;
  const qs = [...stored, ...added];
  // round: this call's number among the EVID's finished calls; a query keeps the round it came in
  const round = (db.prepare("SELECT COUNT(*) AS c FROM runs WHERE state != 'failed'").get() as { c: number }).c + 1;
  const screener = deps.screener;
  if (!screener.ok) return { ok: false, failed: true, error: `screening model: ${screener.reason}. Nothing ran. It is set in the server's .env (${SETTINGS}) by whoever runs the server; calling again will not help until then.` };
  const perQuery = maxResultsPerQuery(env);
  const started = now.toISOString();

  // Search: searchParallel() queries at a time — a query above 200 results is one request (the IDs),
  // NCBI allows 10 a second with a key (3 without), a refused request waits and retries (src/http.ts);
  // a query run before answers from the search cache (search/, a week). Merged in query order.
  // Progress in the log: one line before, one per query as its answer comes (in the order they finish).
  const found = new Array<Awaited<ReturnType<Deps["search"]>>>(qs.length);
  const tS = Date.now();
  deps.log(o.evid, `round ${round}, ${added.length} new queries${stored.length ? `, ${stored.length} from earlier rounds` : ""}${alreadyRun ? `, ${alreadyRun} sent again` : ""}`);
  deps.log(o.evid, `searching ${qs.length} queries, ${added.length} new, ${stored.length} from earlier calls`);
  let nextQ = 0;
  await Promise.all(Array.from({ length: Math.min(searchParallel(env), qs.length) }, async () => {
    while (nextQ < qs.length) {
      const k = nextQ++; const tq = Date.now(); const r = found[k] = await deps.search(qs[k], ownMax.get(qs[k]) ?? perQuery);
      // the step, then its time, as the other tools log it ("query 01.2s …", "cached" in the time's place)
      const secs = `${((Date.now() - tq) / 1000).toFixed(1).padStart(4, "0")}s`;
      deps.log(o.evid, r.ok ? `query ${r.cached ? "cached" : secs} ${k + 1}/${qs.length}, ${r.total} hits, ${r.rows.length} used · ${qs[k]}` : `query failed ${secs} ${k + 1}/${qs.length} · ${r.error} · ${qs[k]}`);
    }
  }));
  const papers = new Map<string, Paper>();
  const runs: { query: string; total: number | null; kept: number; error?: string; hits?: string[] }[] = [];
  let cachedCount = 0;
  for (const [i, query] of qs.entries()) {
    const r = found[i];
    if (!r.ok) { runs.push({ query, total: null, kept: 0, error: r.error }); continue; }
    if (r.cached) cachedCount++;
    runs.push({ query, total: r.total, kept: r.rows.length, hits: r.rows.map((row) => String(row[0])) });
    for (const row of r.rows) {
      const pmid = String(row[0]);
      const p = papers.get(pmid);
      if (p) { if (!p.queries.includes(i)) p.queries.push(i); continue; }
      papers.set(pmid, { pmid, title: row[1] ?? null, first_author: row[2] ?? null, year: row[3] ?? null, journal: row[4] ?? null, types: row[5] ?? null, queries: [i] });   // a row of IDs only: filled by the pre-fill
    }
  }
  deps.log(o.evid, `searched ${((Date.now() - tS) / 1000).toFixed(1).padStart(4, "0")}s ${added.length} new, ${cachedCount} cached`);
  if (runs.every((r) => r.error)) return { ok: false, failed: true, error: `pubmed: every query failed (${runs[0].error}). Nothing was stored; try again later, or check the queries' syntax with fh_pubmed_search_articles.` };
  // Articles are added, never removed: the stored ones a search no longer returns (PubMed's order
  // shifts once the search cache expires; a reference list found earlier) stay in the map.
  const storedArticles = db.prepare("SELECT pmid, title, first_author, year, journal, types, found_by, reviews FROM articles").all() as { pmid: string; title: string | null; first_author: string | null; year: number | null; journal: string | null; types: string | null; found_by: string; reviews: number | null }[];
  for (const a of storedArticles) if (!papers.has(a.pmid)) papers.set(a.pmid, { pmid: a.pmid, title: a.title, first_author: a.first_author, year: a.year ? String(a.year) : null, journal: a.journal, types: a.types, queries: [], ...(a.found_by === "references" && a.reviews ? { reviews: a.reviews } : {}) });

  // Library pre-fill: abstracts for all, 200 PMIDs per request, PREFILL_PARALLEL requests at once
  // (the NCBI pacing in src/http.ts keeps them in NCBI's limit; papers already stored cost none);
  // retracted papers out. Progress in the log: a line before, one every 5 s.
  const ids = [...papers.keys()];
  const retracted = new Set<string>(); let notFound = 0;
  const titleOnly = new Set<string>();   // PubMed has no abstract for these
  const lost: string[] = []; let lostError = "";
  const batches: string[][] = [];
  for (let k = 0; k < ids.length; k += MAX_PMIDS) batches.push(ids.slice(k, k + MAX_PMIDS));
  deps.log(o.evid, `fetching abstracts for ${ids.length} papers`);
  const tP = Date.now();
  let nextB = 0, doneP = 0, lastP = Date.now();
  await Promise.all(Array.from({ length: Math.min(PREFILL_PARALLEL, batches.length) }, async () => {
    while (nextB < batches.length) {
      const b = batches[nextB++];
      const got = await prefillBatch(deps, b);
      if (got.lost.length) { lost.push(...got.lost); lostError ||= got.error ?? ""; }
      for (const r of got.rows) {
        if (r.retracted) retracted.add(r.pmid);
        if (r.level === "title") titleOnly.add(r.pmid);
        if (r.level === "not found") notFound++;
        const p = papers.get(r.pmid);   // what the search did not bring (a row of IDs only): from the stored record
        if (p) { p.title ??= r.title ?? null; p.first_author ??= r.first_author ?? null; p.year ??= r.year ?? null; p.journal ??= r.journal ?? null; p.types ??= r.types ?? null; }
      }
      doneP += b.length;
      if (doneP < ids.length && Date.now() - lastP >= 5000) { lastP = Date.now(); deps.log(o.evid, `fetching abstracts, ${doneP} of ${ids.length} done`); }
    }
  }));
  if (lost.length && lost.length === ids.length) { db.close(); return { ok: false, failed: true, error: `pubmed: no abstracts could be fetched (${lostError}). Nothing was stored; try again later (the searches answer from the cache).` }; }
  if (lost.length) deps.log(o.evid, `abstracts not fetched for ${lost.length} papers (${lostError}): they stay in the map, unscored; a repeat call fetches them`);
  const kept = ids.filter((id) => !retracted.has(id)).map((id) => papers.get(id)!);
  deps.log(o.evid, `prefilled ${((Date.now() - tP) / 1000).toFixed(1).padStart(4, "0")}s ${kept.length} papers, ${ids.length} found, ${retracted.size} retracted, ${notFound} not found`);
  const unique = (i: number) => kept.filter((p) => p.queries.length === 1 && p.queries[0] === i).length;

  const n = qs.length;
  const row = (p: Paper, sc: string | number, sig: string, f: Screened | undefined) => [p.pmid, p.title, p.first_author, p.year, p.journal, p.types, sc, sig, ...FIELDS.map((k) => f?.[k] ?? "")].map(csvCell).join(",");
  // Citation counts (OpenAlex), fetched while nothing else waits on them; a failure leaves the signal out.
  const citesP = deps.cites(kept.map((p) => p.pmid)).then((c) => { deps.log(o.evid, `citations${c.failed ? " failed" : ""} ${c.counts.size} counted, ${c.failed} failed${c.error ? ` · ${c.error}` : ""}`); return c; }, (e) => ({ counts: new Map<string, number>(), failed: kept.length, error: String(e) }));
  let cites = new Map<string, number>();
  let K = 0;
  const signals = (p: Paper) => [p.queries.length ? `in ${p.queries.length} of ${n} queries` : "", p.reviews ? `in ${p.reviews} of ${K} reviews` : "", cites.has(p.pmid) ? `cited ${cites.get(p.pmid)!.toLocaleString("en-US")} times` : ""].filter(Boolean).join(" · ");
  const queriesJson = JSON.stringify({ date: started, max_results_per_query: perQuery, queries: runs.map((r, i) => ({ ...r, unique: r.error ? 0 : unique(i) })) }, null, 2) + "\n";
  // The run report follows the PRISMA flow: records identified (every query's rows), duplicates
  // removed, removed before screening (retracted), screened, excluded (off-topic), included.
  const identified = runs.reduce((a, r) => a + r.kept, 0);
  const base = { started, queries: n, failed_queries: runs.filter((r) => r.error).length, identified, duplicates: identified - ids.length, removed_retracted: retracted.size, not_found: notFound, model: screener.model, endpoint: screener.where };

  // Screening: first one paper alone — a wrong key, model or endpoint fails it, and the
  // research stops with the provider's message instead of a thousand failed calls.
  const t = Date.now();
  const model = screener.model;
  const text = (pmid: string) => { const a = deps.paper(pmid); return a && `${a}\n\nPublication types: ${papers.get(pmid)!.types ?? "none listed"}`; };
  const note = (r: ScreenResult, ms: number) => deps.log(`pmid:${r.pmid}`, screenLine(r, ms, model));
  // Progress in the log under the EVID: a line before, one every 5 s, one at the end.
  const progress = (what: string, total: number) => {
    let n = 0, fresh = 0, cached = 0, failed = 0, refused = 0, last = Date.now(); const t0 = last;
    const counts = () => `${fresh} new, ${cached} cached${failed ? `, ${failed} failed` : ""}${refused ? `, ${refused} refused` : ""}`;
    deps.log(o.evid, `screening ${total} ${what}`);
    return {
      done: (r: ScreenResult) => {
        n++; if (r.refused) refused++; else if (r.error) failed++; else if (r.cached) cached++; else fresh++;
        if (n < total && Date.now() - last >= 5000) { last = Date.now(); deps.log(o.evid, `screening ${n}/${total}, ${counts()}`); }
      },
      end: () => deps.log(o.evid, `screened ${((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0")}s ${total} ${what}, ${counts()}`),
    };
  };
  // An off-topic for an article without an abstract is the title's word alone: not taken (scoreTitleOnly).
  const unjudged = new Set<string>();
  const trusted = (rs: ScreenResult[]): ScreenResult[] => rs.map((r) => {
    if (r.screened?.relevance !== "off-topic" || !titleOnly.has(r.pmid)) return r;
    unjudged.add(r.pmid); return { pmid: r.pmid, error: "no abstract", cached: r.cached };
  });
  const order = kept.map((p) => p.pmid);
  const probe = order.find((pmid) => deps.paper(pmid) !== null);
  const results = probe ? await screenAll(lib, [probe], screening, topic, text, screener.ask, model, 1, note) : [];
  if (probe && results[0].error) {
    const error = results[0].error;
    db.prepare("INSERT INTO runs (started, finished, state, error, report) VALUES (?, ?, 'failed', ?, ?)").run(started, new Date().toISOString(), error, JSON.stringify(base));
    db.close();
    return { ok: false, failed: true, error: `screening failed on the first paper (pmid:${probe}): ${error}. The searches ran: ${kept.length} papers found and stored in the library with their abstracts; nothing was screened, no map yet. Call again once the cause is fixed (the searches answer from the cache).` };
  }
  if (probe) results.splice(0, 1, ...trusted(results));
  const rest = order.filter((pmid) => pmid !== probe), p1 = progress("abstracts", rest.length);
  results.push(...trusted(await screenAll(lib, rest, screening, topic, text, screener.ask, model, screenParallel(env), note, p1.done)));
  p1.end();
  { const keys = screener.keys?.(); if (keys) deps.log(o.evid, `screening key usage: ${keys}`); }
  const by = new Map(results.map((r) => [r.pmid, r]));
  const counted = await citesP; cites = counted.counts;
  // An article found only in reference lists ranks 20 lower unless 3+ of the reviews include it:
  // most references are background to a review, not what this topic rests on (bench 2026-11-19).
  const scoreOf = (p: Paper) => {
    const f = by.get(p.pmid)?.screened;
    if (!f && !unjudged.has(p.pmid)) return { p, f, sc: null };
    const perY = cites.has(p.pmid) ? perYear(cites.get(p.pmid)!, p.year) : 0;
    const s = f ? score(f, p.types, p.queries.length, perY, p.reviews ?? 0) : scoreTitleOnly(p.types, p.queries.length, perY, p.reviews ?? 0);
    return { p, f, sc: s > 0 && !p.queries.length && (p.reviews ?? 0) < 3 ? Math.max(1, s - 20) : s };
  };
  let scored = kept.map(scoreOf);

  // Backward citation searching: the top reviews' reference lists; their articles not yet
  // found are pre-filled and screened like the rest; every article gets "in N of K reviews".
  let fromReviews = 0, refsFailed = 0;
  const reviewIds = [...scored].filter(({ p, f, sc }) => sc && f && REVIEW.test(`${p.types ?? ""} ${f.design}`)).sort((a, b) => b.sc! - a.sc!).slice(0, reviewCount(env)).map(({ p }) => p.pmid);
  if (reviewIds.length) {
    const r = await deps.refs(reviewIds).catch(() => ({ refs: new Map<string, string[]>(), failed: reviewIds.length }));
    refsFailed = r.failed; K = r.refs.size;
    const inc = inclusionCounts(r.refs);
    const fresh = [...inc.keys()].filter((id) => !papers.has(id)).sort((a, b) => inc.get(b)! - inc.get(a)!).slice(0, maxFromReviews(env));
    for (let k = 0; k < fresh.length; k += MAX_PMIDS) {
      const got = await prefillBatch(deps, fresh.slice(k, k + MAX_PMIDS));
      if (got.lost.length) deps.log(o.evid, `references: abstracts not fetched for ${got.lost.length} papers (${got.error}), left out`);
      for (const x of got.rows) {
        if (x.level === "title") titleOnly.add(x.pmid);
        if (x.retracted || x.level === "not found" || papers.has(x.pmid)) continue;
        const p: Paper = { pmid: x.pmid, title: x.title ?? null, first_author: x.first_author ?? null, year: x.year ?? null, journal: x.journal ?? null, types: x.types ?? null, queries: [] };
        papers.set(x.pmid, p); kept.push(p); fromReviews++;
      }
    }
    for (const p of kept) { const c = inc.get(p.pmid); if (c) p.reviews = c; }
    const added = kept.slice(kept.length - fromReviews).map((p) => p.pmid);
    deps.log(o.evid, `references${refsFailed ? " failed" : ""} ${K} reviews, ${refsFailed} failed, ${fromReviews} new papers`);
    if (added.length) {
      const p2 = progress("abstracts from the reviews' references", added.length);
      results.push(...trusted(await screenAll(lib, added, screening, topic, text, screener.ask, model, screenParallel(env), note, p2.done)));
      p2.end();
      { const keys = screener.keys?.(); if (keys) deps.log(o.evid, `screening key usage: ${keys}`); }
      for (const r2 of results) by.set(r2.pmid, r2);
      const more = await deps.cites(added).catch(() => ({ counts: new Map<string, number>(), failed: added.length }));
      for (const [k2, v] of more.counts) cites.set(k2, v);
    }
    scored = kept.map(scoreOf);
  }
  const screenedCsv = [["pmid", "kept", "error", ...FIELDS].join(","), ...scored.map(({ p, f, sc }) => [p.pmid, sc === null ? "" : sc > 0 ? "yes" : "no", by.get(p.pmid)?.error ?? (by.get(p.pmid)?.refused ? "refused" : ""), ...FIELDS.map((k) => f?.[k] ?? "")].map(csvCell).join(","))].join("\n") + "\n";
  // Unscreened papers (an error, no text) stay in, unscored at the end: the reader decides.
  const ranked = scored.filter(({ sc }) => sc !== 0).sort((a, b) => (b.sc ?? -1) - (a.sc ?? -1));
  const lines = ranked.map(({ p, f, sc }) => row(p, sc ?? "", signals(p), f));
  const count = (k: string) => results.filter((r) => r.screened?.relevance === k).length;
  const failures = results.filter((r) => r.error && !unjudged.has(r.pmid));
  const refused = results.filter((r) => r.refused).length;
  const screenRun = { screened: results.filter((r) => r.screened).length, not_screened: failures.length, ...(unjudged.size ? { no_abstract: unjudged.size } : {}), refused, ...(failures.length ? { first_error: failures[0].error } : {}), excluded: count("off-topic"), relevance: { direct: count("direct"), indirect: count("indirect"), background: count("background") }, cached: results.filter((r) => r.cached).length, citations: { counted: cites.size, failed: counted.failed }, citation_searching: { reviews: K, identified: fromReviews, failed: refsFailed }, seconds: Math.round((Date.now() - t) / 1000) };
  // The database (src/evmapdb.ts, layout 2): queries and their hits, the articles added or updated
  // with their signals, screening answer and score. A new screening hash (model, prompt, topic,
  // answer fields) clears the screening and score columns first; the queries stay.
  const hash = cacheKey(model, screening, topic);
  const state = "screened" as const;
  const finished = new Date().toISOString();
  db.exec("BEGIN");
  try {
    if (metaOf(db, "hash") !== hash) db.exec("UPDATE articles SET relevance = NULL, population = NULL, design = NULL, n = NULL, outcome = NULL, finding = NULL, aspect = NULL, reason = NULL, error = NULL, score = NULL");
    const qUp = db.prepare("INSERT INTO queries (query, total, kept, error, searched, round, max_results) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(query) DO UPDATE SET total = excluded.total, kept = excluded.kept, error = excluded.error, searched = excluded.searched, max_results = excluded.max_results RETURNING id");
    const hDel = db.prepare("DELETE FROM query_hits WHERE query_id = ?");
    const hIns = db.prepare("INSERT OR IGNORE INTO query_hits (query_id, pmid, rank) VALUES (?, ?, ?)");
    for (const r of runs) {
      const id = (qUp.get(r.query, r.total, r.kept, r.error ?? null, started, round, ownMax.get(r.query) ?? null) as { id: number }).id;
      if (r.hits) { hDel.run(id); r.hits.forEach((pmid, k) => hIns.run(id, pmid, k + 1)); }
    }
    const aUp = db.prepare(`INSERT INTO articles (pmid, title, first_author, year, journal, types, found_by, added, reviews, citations) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pmid) DO UPDATE SET title = excluded.title, first_author = excluded.first_author, year = excluded.year, journal = coalesce(excluded.journal, articles.journal), types = excluded.types,
        found_by = CASE WHEN excluded.found_by = 'queries' THEN 'queries' ELSE articles.found_by END, reviews = excluded.reviews, citations = coalesce(excluded.citations, articles.citations)`);
    for (const p of kept) aUp.run(p.pmid, p.title, p.first_author, Number(p.year) || null, p.journal, p.types, p.queries.length ? "queries" : "references", started, p.reviews ?? 0, cites.get(p.pmid) ?? null);
    const sUp = db.prepare("UPDATE articles SET relevance = ?, population = ?, design = ?, n = ?, outcome = ?, finding = ?, aspect = ?, reason = ?, error = ? WHERE pmid = ?");
    for (const r of results) { const f = r.screened; sUp.run(f?.relevance ?? null, f?.population ?? null, f?.design ?? null, typeof f?.n === "number" ? f.n : null, f?.outcome ?? null, f?.finding ?? null, f?.aspect ?? null, f?.reason ?? null, r.error ?? (r.refused ? "refused" : null), r.pmid); }
    // what kind of study each article is goes to the library with the article: the same for every topic (src/characteristics.ts)
    for (const r of results) if (r.screened) try { storeCharacteristics(lib, r.pmid, r.screened, model); } catch { /* the map does not depend on it */ }
    db.exec("UPDATE articles SET score = NULL");
    const rUp = db.prepare("UPDATE articles SET score = ? WHERE pmid = ?");
    for (const { p, sc } of ranked) rUp.run(sc, p.pmid);
    db.exec("UPDATE articles SET queries = (SELECT count(*) FROM query_hits h WHERE h.pmid = articles.pmid)");
    const meta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    meta.run("hash", hash); meta.run("model", model); meta.run("prompt", screening); meta.run("topic", topic); meta.run("updated", finished);
    db.prepare("INSERT INTO runs (started, finished, state, error, report) VALUES (?, ?, ?, NULL, ?)").run(started, finished, state, JSON.stringify({ ...base, queries: qs.length, new_queries: qs.length - stored.length, ...screenRun, included: lines.length }));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); db.close(); return { ok: false, failed: true, error: `evidence map database: ${e instanceof Error ? e.message : String(e)}` }; }
  db.close();
  const partial = failures.length ? { screening_errors: failures.length, first_error: failures[0].error, note: `${failures.length} of ${results.length} papers could not be screened; they stay in the map, unscored, at the end. Call again to retry only those: screened papers answer from the cache.` } : {};
  const citesFailed = counted.failed || refsFailed ? { citations_error: `citation counts failed for ${counted.failed} of ${kept.length} articles, reference lists for ${refsFailed} of ${reviewIds.length} reviews${counted.error ? ` (${counted.error})` : ""}: the order is weaker. Call again later with the evid and the same queries: searches and screening answer from the cache.` } : {};
  // Only what the calling model can act on: queries to fix, articles to retry, failed citations.
  const failedQueries = runs.filter((r) => r.error).map((r) => ({ query: r.query, error: r.error! }));
  const emptyQueries = runs.filter((r) => !r.error && r.total === 0).map((r) => r.query);
  return { ok: true, evid: o.evid, included: lines.length, ...(failedQueries.length ? { failed_queries: failedQueries } : {}), ...(emptyQueries.length ? { empty_queries: emptyQueries } : {}), ...partial, ...citesFailed, ...(alreadyRun ? { already_run: alreadyRun } : {}) };
}

// fh_evmap_get_query_performance: how each query of the EVID did, in the order they were added —
// round (the call that brought it in), hits (PubMed), used (fewer than hits: cut off at the per-query maximum), kept (screening
// positive), unique (kept, found by no other query), picked (picked for an aspect of the map).
export const QUERY_PERFORMANCE_SELECT = `
  WITH kept AS (SELECT pmid FROM articles WHERE relevance IS NOT NULL AND relevance != 'off-topic'),
       top AS (SELECT DISTINCT pmid FROM item_picks),
       n AS (SELECT pmid, COUNT(*) AS c FROM query_hits GROUP BY pmid)
  SELECT q.round AS round, q.query AS query, q.total AS hits, q.kept AS used,
         COALESCE(SUM(h.pmid IN kept), 0) AS kept,
         COALESCE(SUM(h.pmid IN kept AND n.c = 1), 0) AS "unique",
         COALESCE(SUM(h.pmid IN top), 0) AS picked
  FROM queries q LEFT JOIN query_hits h ON h.query_id = q.id LEFT JOIN n ON n.pmid = h.pmid
  GROUP BY q.id ORDER BY q.round, q.id`;
export function getQueryPerformance(lib: string, evid: string): ({ ok: true; evid: string } & Rows) | Fail {
  const o = openEvid(lib, evid);
  if (!o.ok) return o;
  const db = openDb(o.dir, true);
  if (!db) return { ok: false, error: `${o.evid}: no evidence map yet — fh_evmap_create_map first` };
  try {
    if (!db.prepare("SELECT value FROM meta WHERE key = 'updated'").get()) return { ok: false, error: `${o.evid}: no evidence map yet — the last fh_evmap_create_map did not finish: ${lastRun(db)?.error ?? "no run recorded"}` };
    // a map of layout 3 (no round yet, read-only here): all its queries were round 1
    const hasRound = db.prepare("PRAGMA table_info(queries)").all().some((c: { name: string }) => c.name === "round");
    return { ok: true, evid: o.evid, ...query(db, hasRound ? QUERY_PERFORMANCE_SELECT : QUERY_PERFORMANCE_SELECT.replace("q.round AS round", "1 AS round").replace("ORDER BY q.round, q.id", "ORDER BY q.id"), [], 0, 10_000) };
  } finally { db.close(); }
}

