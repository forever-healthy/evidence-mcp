import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { openalexParams } from "./contact.js";
import { daysSince, today, writeAtomic } from "./entry.js";
import { fetchText } from "./http.js";
import { parseId } from "./ids.js";
import { FH_EVIDENCE_DIR } from "./layout.js";
import { efetchUrl } from "./pubmed.js";
import { COLUMNS, esummaryUrl, parseEsummary, yearRange, type Row } from "./pubmedsearch.js";
import { searchCacheDays, searchFile } from "./trials.js";

// fh_citing_articles (#75): the
// papers that cite a paper. PubMed has no complete "cited by"; OpenAlex has —
// compared with Semantic Scholar on six telmisartan papers (2026-11-16), OpenAlex
// found as many or more for five, and more with a PMID. OpenAlex lists the citing
// papers with a PMID, filtered by year and sorted there (cites:W, has_pmid:true,
// publication_year, sort — 200 a page, ~1 s); PubMed's esummary makes the rows, in
// fh_pubmed_search_articles' columns, and its publication types are what `types`
// filters on. No OpenAlex key: page= paging works up to 10,000 results without one.
//
// #76 (the AI4L-dev test on ONTARGET, 2026-11-16):
// * Comments about the paper: a citing paper of type Comment is mostly about
//   something else (2020 COVID letters citing ONTARGET). PubMed's CommentIn links
//   on the paper's record name the comments on it — 15 for ONTARGET, of which
//   OpenAlex has 6 (journal clubs carry no references); OpenAlex has 8 more that
//   PubMed does not link. So with comment, letter or editorial in types: the
//   CommentIn papers first (any year, any type), listed in comments_on, then
//   OpenAlex's citing papers of the types.
// * One year: years and newest go by the year column (PubMed's), not OpenAlex's
//   date (online first vs print): OpenAlex is asked for a year more on each side,
//   the rows are filtered and sorted on PubMed's year.

export const MAX_RESULTS = 100, DEFAULT_RESULTS = 20;
const PAGE = 200, MAX_PAGES = 50;   // OpenAlex: 200 a page; page= reaches 10,000 without a key
export type Sort = "newest" | "cited";
export type Query = { id: string; types?: string[]; years?: string; sort: Sort; max_results: number };
export type Result = { source: "openalex+pubmed"; query: Query; total: number; comments_on?: string[]; columns: typeof COLUMNS; rows: Row[]; searched: string };
export type Outcome = { ok: true; result: Result; cached: boolean } | { ok: false; error: string; input?: true };   // input: the caller's mistake, logged as error; else failed

// "meta-analysis", "Meta-Analysis", "RCT": one spelling to compare
const ALIAS: Record<string, string> = { rct: "randomized controlled trial", "systematic-review": "systematic review" };
const norm = (t: string) => { const s = t.toLowerCase().replace(/[-_\s]+/g, " ").trim(); return ALIAS[s.replace(/ /g, "-")] ?? ALIAS[s] ?? s; };

export function normalizeQuery(q: { id?: string; types?: string[]; years?: string; sort?: string; max_results?: number }): Query | { error: string } {
  const p = parseId(q.id ?? "");
  if (p.error || !p.id) return { error: p.error ?? "invalid id" };
  if (p.type !== "pmid" && p.type !== "doi") return { error: `citations need a paper's pmid: or doi:, not ${p.type}:` };
  const sort = (q.sort ?? "newest") as Sort;
  if (!["newest", "cited"].includes(sort)) return { error: `sort must be newest or cited, not "${String(q.sort)}"` };
  const yr = yearRange(q.years);
  if (yr && "error" in yr) return yr;
  const out: Query = { id: `${p.type}:${p.id}`, sort, max_results: Math.min(MAX_RESULTS, Math.max(1, Math.floor(q.max_results ?? DEFAULT_RESULTS))) };
  const types = [...new Set((q.types ?? []).map(norm).filter(Boolean))].sort();
  if (types.length) out.types = types;
  if (yr) out.years = `${yr.min === "1000" ? "" : yr.min}-${yr.max}`;
  return out;
}

export const searchKey = (q: Query) => createHash("sha1").update(JSON.stringify(["cites2", q.id, q.types ?? [], q.years ?? "", q.sort, q.max_results])).digest("hex").slice(0, 16);

export type Fetch = (url: string) => Promise<string>;
const live: Fetch = (url) => fetchText(url, { "User-Agent": "evidence-mcp", Accept: "application/json" });
const OA = "https://api.openalex.org";
const mailto = () => openalexParams();

const COMMENT_TYPES = ["comment", "letter", "editorial"];
const wantsComments = (q: Query) => !!q.types?.some((t) => COMMENT_TYPES.includes(t));

// One page of the citing papers, OpenAlex's filter and order: their PMIDs, and how many there are.
// slack: a year more on each side of years, for PubMed's year to filter on.
export function citingUrl(work: string, q: Query, page: number, perPage = PAGE, slack = 1): string {
  const yr = yearRange(q.years);
  const years = yr && !("error" in yr) ? `,publication_year:${yr.min === "1000" ? "" : Number(yr.min) - slack}-${Number(yr.max) + slack}` : "";
  return `${OA}/works?filter=cites:${work},has_pmid:true${years}&sort=${q.sort === "cited" ? "cited_by_count:desc" : "publication_date:desc"}&per-page=${perPage}&page=${page}&select=ids&${mailto()}`;
}
// The PMIDs PubMed links as comments on the paper: <CommentsCorrections RefType="CommentIn"> in its record.
export function parseCommentIn(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<CommentsCorrections\b[^>]*RefType="CommentIn"[^>]*>([\s\S]*?)<\/CommentsCorrections>/g)) {
    const p = /<PMID\b[^>]*>(\d+)<\/PMID>/.exec(m[1])?.[1];
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
export function parseCiting(json: string): { total: number; pmids: string[] } {
  const d: J = JSON.parse(json);
  const pmids = (Array.isArray(d?.results) ? d.results : []).map((r: J) => String(r?.ids?.pmid ?? "").split("/").pop() ?? "").filter((s: string) => /^\d+$/.test(s));
  return { total: Number(d?.meta?.count ?? 0) || 0, pmids };
}
const typeMatch = (row: Row, types: string[]) => { const have = (row[5] ?? "").split(";").map(norm); return types.some((t) => have.some((h) => h.includes(t))); };

export async function citingArticles(raw: { id?: string; types?: string[]; years?: string; sort?: string; max_results?: number }, libraryDir = FH_EVIDENCE_DIR, fetchImpl: Fetch = live): Promise<Outcome> {
  const q = normalizeQuery(raw);
  if ("error" in q) return { ok: false, error: q.error, input: true };
  const file = searchFile(libraryDir, searchKey(q));
  if (existsSync(file)) {
    try { const r = JSON.parse(readFileSync(file, "utf8")) as Result; if (daysSince(r.searched) < searchCacheDays()) return { ok: true, result: r, cached: true }; } catch { /* half a file is no file */ }
  }
  let work: string, pmid: string | null;
  try {
    const w: J = JSON.parse(await fetchImpl(`${OA}/works/${q.id}?select=id,ids&${mailto()}`));
    work = String(w?.id ?? "").split("/").pop() ?? "";
    if (!work) return { ok: false, error: `openalex: ${q.id} not found` };
    pmid = q.id.startsWith("pmid:") ? q.id.slice(5) : (String(w?.ids?.pmid ?? "").split("/").pop() || null);
  } catch (e) { const m = e instanceof Error ? e.message : String(e); return /\b404\b/.test(m) ? { ok: false, error: `${q.id} not in OpenAlex`, input: true } : { ok: false, error: `openalex: ${m}` }; }
  const yr = yearRange(q.years);
  const inYears = (r: Row) => !yr || "error" in yr || (!!r[3] && r[3] >= yr.min && r[3] <= yr.max);
  const newestFirst = (rows: Row[]) => q.sort === "newest" ? rows.sort((a, b) => (b[3] ?? "").localeCompare(a[3] ?? "")) : rows;   // stable: OpenAlex's order within a year
  let rows: Row[], count: number, commentsOn: string[];
  try {
    // The comments PubMed links to the paper, first: whatever their year and type.
    let comments: Row[] = [];
    if (wantsComments(q) && pmid) {
      const ids = parseCommentIn(await fetchImpl(efetchUrl(pmid)));
      if (ids.length) comments = newestFirst(parseEsummary(await fetchImpl(esummaryUrl(ids)), ids, libraryDir));
    }
    const seen = new Set(comments.map((r) => r[0]));
    // Without types: the first rows are the answer. With types: every citing paper is
    // looked up in PubMed (types are PubMed's), the total those that match.
    const cited: Row[] = []; let total = 0, matched = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { total: n, pmids } = parseCiting(await fetchImpl(citingUrl(work, q, page)));
      total = n;
      if (!pmids.length) break;
      const need = pmids.filter((p) => !seen.has(p));
      const got = need.length ? parseEsummary(await fetchImpl(esummaryUrl(need)), need, libraryDir) : [];
      for (const r of got) {
        if (!inYears(r) || (q.types && !typeMatch(r, q.types))) continue;
        matched++;
        cited.push(r);
      }
      if (!q.types && comments.length + cited.length >= q.max_results) break;
      if (page * PAGE >= n) break;
    }
    // Without types, a years total is OpenAlex's count for exactly those years.
    if (!q.types && q.years) total = parseCiting(await fetchImpl(citingUrl(work, q, 1, 1, 0))).total;
    rows = [...comments, ...newestFirst(cited)].slice(0, q.max_results);
    count = q.types ? comments.length + matched : total;
    commentsOn = comments.slice(0, rows.length).map((r) => r[0]);   // they lead the rows
  } catch (e) { return { ok: false, error: `citations: ${e instanceof Error ? e.message : String(e)}` }; }
  const result: Result = { source: "openalex+pubmed", query: q, total: count, ...(commentsOn.length ? { comments_on: commentsOn } : {}), columns: COLUMNS, rows, searched: today() };
  try { mkdirSync(dirname(file), { recursive: true }); writeAtomic(file, JSON.stringify(result, null, 2) + "\n"); } catch { /* the cache is a courtesy */ }
  return { ok: true, result, cached: false };
}
