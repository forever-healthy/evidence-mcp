import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { reviewTypes } from "./json.js";
import { contactEmail } from "./contact.js";
import { daysSince, emptyStatus, entryExists, readStatus, today, writeAtomic } from "./entry.js";
import { fetchText } from "./http.js";
import { entryPaths, FH_EVIDENCE_DIR } from "./layout.js";
import { searchCacheDays, searchFile } from "./trials.js";

// fh_pubmed_search_articles: the old server's pubmed_search_articles,
// cached. The fleet's logs (2–8 Nov 2026): 6,051 calls — a query in PubMed's
// own syntax (half with field tags), summaries always wanted, 5–60 rows,
// sort by date in a fifth, a year range in 2% — for the review's searches:
// systematic reviews and meta-analyses (ER.md 13.1), benefits (16.12), side
// effects (18.12), interactions (20.1). Two NCBI calls: esearch for the IDs and
// the count, one esummary for the rows. Rows as arrays in COLUMNS order; the
// library level is on the row when the paper is already stored, so the model
// knows what it can read at once. Cached under search/ for FH_SEARCH_CACHE_DAYS.

export const MAX_RESULTS = 100, DEFAULT_RESULTS = 20;
export type Sort = "relevance" | "newest";
export type Query = { query: string; sort: Sort; years?: string; max_results: number };
export const COLUMNS = ["pmid", "title", "first_author", "year", "journal", "publication_types", "pmcid", "level"] as const;
export type Row = [string, string | null, string | null, string | null, string | null, string | null, string | null, string | null];
export type Result = { source: "pubmed"; query: Query; total: number; columns: typeof COLUMNS; rows: Row[]; searched: string };

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const ident = (u: URL) => { if (process.env.FH_NCBI_API_KEY) u.searchParams.set("api_key", process.env.FH_NCBI_API_KEY); u.searchParams.set("tool", "evidence-mcp"); u.searchParams.set("email", contactEmail()); return u.toString(); };

// "2020-2026", "2022-", "-2019" or "2022": publication-date bounds for esearch.
export function yearRange(years: string | undefined): { min: string; max: string } | { error: string } | null {
  const t = (years ?? "").replace(/\s+/g, "");
  if (!t) return null;
  const m = /^(\d{4})?(-)?(\d{4})?$/.exec(t);
  if (!m || (!m[1] && !m[3])) return { error: `years must be "2020-2026", "2022-", "-2019" or "2022", not "${years}"` };
  const min = m[1] ?? "1000", max = m[3] ?? (m[2] ? String(new Date().getFullYear()) : m[1]!);
  return { min, max };
}

export function normalizeQuery(q: { query?: string; sort?: string; years?: string; max_results?: number }): Query | { error: string } {
  const query = (q.query ?? "").replace(/\s+/g, " ").trim();
  if (!query) return { error: "empty query" };
  const sort = (q.sort ?? "relevance") as Sort;
  if (!["relevance", "newest"].includes(sort)) return { error: `sort must be relevance or newest, not "${String(q.sort)}"` };
  const yr = yearRange(q.years);
  if (yr && "error" in yr) return yr;
  const out: Query = { query, sort, max_results: Math.min(MAX_RESULTS, Math.max(1, Math.floor(q.max_results ?? DEFAULT_RESULTS))) };
  if (yr) out.years = `${yr.min === "1000" ? "" : yr.min}-${yr.max}`;
  return out;
}

export const searchKey = (q: Query) => createHash("sha1").update(JSON.stringify(["pubmed", q.query, q.sort, q.years ?? "", q.max_results])).digest("hex").slice(0, 16);

export function esearchUrl(q: Query): string {
  const u = new URL(`${EUTILS}/esearch.fcgi`);
  u.searchParams.set("db", "pubmed"); u.searchParams.set("term", q.query); u.searchParams.set("retmax", String(q.max_results)); u.searchParams.set("retmode", "json");
  u.searchParams.set("sort", q.sort === "newest" ? "pub_date" : "relevance");   // esearch's default order is date added, not relevance
  const yr = yearRange(q.years);
  if (yr && !("error" in yr)) { u.searchParams.set("datetype", "pdat"); u.searchParams.set("mindate", yr.min); u.searchParams.set("maxdate", yr.max); }
  return ident(u);
}
export function esummaryUrl(pmids: string[]): string {
  const u = new URL(`${EUTILS}/esummary.fcgi`);
  u.searchParams.set("db", "pubmed"); u.searchParams.set("id", pmids.join(",")); u.searchParams.set("retmode", "json");
  return ident(u);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
export function parseEsearch(json: string): { total: number; ids: string[] } {
  const d: J = JSON.parse(json); const r = d?.esearchresult ?? {};
  return { total: Number(r.count ?? 0) || 0, ids: Array.isArray(r.idlist) ? r.idlist.map(String) : [] };
}

// The summaries as rows, in the order the IDs came back from the search.
export function parseEsummary(json: string, ids: string[], libraryDir: string): Row[] {
  const d: J = JSON.parse(json); const res = d?.result ?? {};
  const rows: Row[] = [];
  for (const id of ids) {
    const s = res[id]; if (!s || s.error) continue;
    const year = /\b(\d{4})\b/.exec(String(s.pubdate ?? ""))?.[1] ?? null;
    const first = String(s.sortfirstauthor ?? (Array.isArray(s.authors) && s.authors[0]?.name) ?? "").replace(/\s+[A-Z]{1,3}$/, "").trim() || null;   // "Diaconu CC" → Diaconu
    const pmc = (Array.isArray(s.articleids) ? s.articleids : []).find((a: J) => a.idtype === "pmc")?.value ?? null;
    const types = Array.isArray(s.pubtype) ? reviewTypes(s.pubtype.map(String)).join("; ") : "";
    rows.push([id, String(s.title ?? "").replace(/\.$/, "") || null, first, year, s.source ? String(s.source) : null, types || null, pmc ? String(pmc) : null, levelOf(id, libraryDir)]);
  }
  return rows;
}

// The paper's level in the library now, or null when it is not stored.
function levelOf(id: string, libraryDir: string): string | null {
  const paths = entryPaths(libraryDir, "pmid", id);
  return entryExists(paths) ? String(readStatus(paths, emptyStatus(`pmid:${id}`, "pmid", id, libraryDir)).level) : null;
}

export type Fetch = (url: string) => Promise<string>;
const live: Fetch = (url) => fetchText(url, { "User-Agent": "evidence-mcp", Accept: "application/json" });
export type Outcome = { ok: true; result: Result; cached: boolean } | { ok: false; error: string; input?: true };   // input: the caller's mistake, logged as error; else failed

export async function searchArticles(raw: { query?: string; sort?: string; years?: string; max_results?: number }, libraryDir = FH_EVIDENCE_DIR, fetchImpl: Fetch = live): Promise<Outcome> {
  const q = normalizeQuery(raw);
  if ("error" in q) return { ok: false, error: q.error, input: true };
  const file = searchFile(libraryDir, searchKey(q));
  if (existsSync(file)) {
    try {
      const r = JSON.parse(readFileSync(file, "utf8")) as Result;
      // The listing is a week's, the level is today's: a paper added since the search shows its level
      // (2026-11-15: three papers added after a search still read null in its cached answer).
      if (daysSince(r.searched) < searchCacheDays()) return { ok: true, result: { ...r, rows: r.rows.map((row) => { const c = [...row] as Row; c[7] = levelOf(String(row[0]), libraryDir); return c; }) }, cached: true };
    } catch { /* half a file is no file */ }
  }
  let total: number, ids: string[];
  try { ({ total, ids } = parseEsearch(await fetchImpl(esearchUrl(q)))); } catch (e) { return { ok: false, error: `pubmed: ${e instanceof Error ? e.message : String(e)}` }; }
  let rows: Row[] = [];
  if (ids.length) {
    try { rows = parseEsummary(await fetchImpl(esummaryUrl(ids)), ids, libraryDir); } catch (e) { return { ok: false, error: `pubmed: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  const result: Result = { source: "pubmed", query: q, total, columns: COLUMNS, rows, searched: today() };
  try { mkdirSync(dirname(file), { recursive: true }); writeAtomic(file, JSON.stringify(result, null, 2) + "\n"); } catch { /* the cache is a courtesy */ }
  return { ok: true, result, cached: false };
}

