import { reviewTypes } from "./json.js";
import { contactEmail } from "./contact.js";
import { emptyStatus, entryExists, readStatus, writeEntry, type Status } from "./entry.js";
import { fetchText } from "./http.js";
import { parseId } from "./ids.js";
import { entryPaths, FH_EVIDENCE_DIR } from "./layout.js";
import { parsePubmedXml } from "./pubmed.js";
import { freshMissing, rememberMissing } from "./missing.js";
import { settings } from "./config.js";

// fh_pubmed_fetch_articles: the old server's pubmed_fetch_articles —
// title, year, type and retraction for a batch of PMIDs — answered from the
// library. The fleet's logs (2–8 Nov 2026): 7,152 calls, median 10 PMIDs,
// ~2,500 characters back per PMID (every author with affiliation), used for
// the title match (ER.md 13.12, 28.12) and the retraction check (2.13).
//
// Back end: a PMID already in the library is read from disk. The missing ones
// go to PubMed in ONE efetch (up to MAX_PMIDS per request), and each record is
// stored exactly as fh_library_add stores its first stage — XML, abstract
// Markdown, meta with notices — with no attempts recorded, so a later
// fh_library_add or fh_library_read runs the full-text cascade as on an untried
// entry. The library fills at abstract level in batches instead of one PMID at
// a time. An entry is checked again right before writing: a concurrent
// fh_library_add that already stored a full text is never overwritten.
//
// Answer: rows as arrays in COLUMNS order, ~120 characters each.

export const MAX_PMIDS = 200;
export const COLUMNS = ["pmid", "title", "first_author", "year", "publication_types", "retracted", "level"] as const;
// level: abstract | full_text | title (nothing to read) | not found (PubMed has no such record — remembered for
// retry_after_days, src/missing.ts) | invalid (not a PMID: PubMed IDs have at most eight digits)
export type Row = [string, string | null, string | null, string | null, string | null, boolean | null, string];
export type BatchResult = { columns: typeof COLUMNS; rows: Row[]; new: number; cached: number; not_found: number; invalid: number; asked: number };   // asked: PMIDs requested from PubMed (0: all from disk)

const EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
export function efetchBatchUrl(pmids: string[]): string {
  const u = new URL(EFETCH);
  u.searchParams.set("db", "pubmed");
  u.searchParams.set("id", pmids.join(","));
  u.searchParams.set("retmode", "xml");
  if (process.env.FH_NCBI_API_KEY) u.searchParams.set("api_key", process.env.FH_NCBI_API_KEY);
  u.searchParams.set("tool", "evidence-mcp");
  u.searchParams.set("email", contactEmail());
  return u.toString();
}

// One PubmedArticleSet with many articles → one single-article document per
// PMID, as parsePubmedXml and the stored -abstract.xml expect it.
export function splitArticles(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<(PubmedArticle|PubmedBookArticle)\b[\s\S]*?<\/\1>/g)) {
    const pmid = /<PMID[^>]*>(\d+)<\/PMID>/.exec(m[0])?.[1];
    if (pmid && !out.has(pmid)) out.set(pmid, `<?xml version="1.0" ?>\n<PubmedArticleSet>${m[0]}</PubmedArticleSet>\n`);
  }
  return out;
}

const row = (pmid: string, s: Status | null, level: string): Row =>
  s ? [pmid, s.title ? s.title.replace(/\.$/, "") : s.title, s.first_author, s.year, reviewTypes(s.publication_types).join("; ") || null, s.retracted, level] : [pmid, null, null, null, null, null, level];

export type Fetch = (url: string) => Promise<string>;

export async function fetchArticles(ids: string[], libraryDir = FH_EVIDENCE_DIR, converter = "evidence-mcp", fetchImpl: Fetch = fetchText): Promise<BatchResult> {
  const result: BatchResult = { columns: COLUMNS, rows: [], new: 0, cached: 0, not_found: 0, invalid: 0, asked: 0 };
  // Parse and dedupe, keeping the input order; a row per distinct PMID.
  const order: string[] = []; const invalid = new Map<string, string>();
  for (const raw of ids.slice(0, MAX_PMIDS)) {
    const p = parseId(String(raw));
    if (p.error || p.type !== "pmid" || !/^\d{1,8}$/.test(p.id!)) { const k = String(raw).trim(); if (!invalid.has(k)) { invalid.set(k, "invalid"); order.push(k); } continue; }
    if (!order.includes(p.id!)) order.push(p.id!);
  }
  const status = (pmid: string) => { const paths = entryPaths(libraryDir, "pmid", pmid); return entryExists(paths) ? readStatus(paths, emptyStatus(`pmid:${pmid}`, "pmid", pmid, libraryDir)) : null; };
  const retry = settings().retry_after_days;
  const known = (pmid: string) => !!freshMissing(entryPaths(libraryDir, "pmid", pmid), retry);   // remembered as not found
  const missing = order.filter((k) => !invalid.has(k) && !status(k) && !known(k));
  let records = new Map<string, string>();
  if (missing.length) records = splitArticles(await fetchImpl(efetchBatchUrl(missing)));
  result.asked = missing.length;
  for (const k of order) {
    if (invalid.has(k)) { result.rows.push(row(k, null, "invalid")); result.invalid++; continue; }
    let s = status(k);
    if (s) { result.rows.push(row(k, s, String(s.level))); result.cached++; continue; }
    const paths = entryPaths(libraryDir, "pmid", k);
    if (known(k)) { result.rows.push(row(k, null, "not found")); result.not_found++; continue; }
    const xml = records.get(k);
    const record = xml ? parsePubmedXml(xml) : null;
    if (!record) { rememberMissing(paths, "pmid not found"); result.rows.push(row(k, null, "not found")); result.not_found++; continue; }
    if (!entryExists(paths)) writeEntry(paths, record, xml!, converter);   // checked again: a concurrent add may have stored more meanwhile
    s = status(k)!;
    result.rows.push(row(k, s, String(s.level))); result.new++;
  }
  return result;
}
