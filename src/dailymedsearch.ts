import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { daysSince, emptyStatus, entryExists, readStatus, today, writeAtomic } from "./entry.js";
import { fetchText, LIBRARY_UA } from "./http.js";
import { entryPaths, FH_EVIDENCE_DIR } from "./layout.js";
import { searchCacheDays, searchFile } from "./trials.js";

// fh_dailymed_search_labels: FDA drug labels by name, so an agent has the set
// ID for dailymed:<set ID> in one call. Before it (live, 2026-11-07–16) agents
// fetched DailyMed's search page with fh_fetch_url (136 times) or its API URL,
// and picked the set ID out of the page, for 773 dailymed: adds.
// DailyMed's own API — the set IDs it returns are the ones dailymed: takes:
//   GET https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=…[&labeler=…]&pagesize=…
// newest first. A generic name returns every maker's label (telmisartan: 69,
// most of them generics and repackagers): `labeler` narrows to one company
// ("Boehringer" for the originator), a brand name ("Micardis") to its labels.
// The title carries the form and the labeler in brackets
// ("TELMISARTAN TABLET [PD-RX PHARMACEUTICALS, INC.]"): split into the two.
// Cached under search/ for FH_SEARCH_CACHE_DAYS, as the other searches; the
// library level is read fresh on every answer.

export const MAX_RESULTS = 100, DEFAULT_RESULTS = 20;
export type Query = { drug_name: string; labeler?: string; max_results: number };
export const COLUMNS = ["set_id", "title", "labeler", "published", "version", "level"] as const;
export type Row = [string, string, string | null, string | null, number | null, string | null];
export type Result = { source: "dailymed"; query: Query; total: number; columns: typeof COLUMNS; rows: Row[]; searched: string };

const API = "https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json";
const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

export function normalizeQuery(q: { drug_name?: string; labeler?: string; max_results?: number }): Query | { error: string } {
  const drug_name = (q.drug_name ?? "").replace(/\s+/g, " ").trim();
  if (!drug_name) return { error: "empty drug_name" };
  const labeler = (q.labeler ?? "").replace(/\s+/g, " ").trim();
  const out: Query = { drug_name, max_results: Math.min(MAX_RESULTS, Math.max(1, Math.floor(q.max_results ?? DEFAULT_RESULTS))) };
  if (labeler) out.labeler = labeler;
  return out;
}

export const searchKey = (q: Query) => createHash("sha1").update(JSON.stringify(["dailymed", q.drug_name.toLowerCase(), (q.labeler ?? "").toLowerCase(), q.max_results])).digest("hex").slice(0, 16);

export function searchUrl(q: Query): string {
  const u = new URL(API);
  u.searchParams.set("drug_name", q.drug_name);
  if (q.labeler) u.searchParams.set("labeler", q.labeler);
  u.searchParams.set("pagesize", String(q.max_results));
  return u.toString();
}

// "Nov 04, 2026" → "2026-11-04"
export const isoDate = (d: unknown): string | null => {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(String(d ?? "").trim());
  return m && MONTHS[m[1]] ? `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, "0")}` : null;
};

// "TELMISARTAN TABLET [PD-RX PHARMACEUTICALS, INC.]" → ["TELMISARTAN TABLET", "PD-RX PHARMACEUTICALS, INC."]
export function splitTitle(t: string): [string, string | null] {
  const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(t.trim());
  return m ? [m[1], m[2]] : [t.trim(), null];
}

function levelOf(setid: string, libraryDir: string): string | null {
  const paths = entryPaths(libraryDir, "dailymed", setid);
  return entryExists(paths) ? String(readStatus(paths, emptyStatus(`dailymed:${setid}`, "dailymed", setid, libraryDir)).level) : null;
}

type J = { data?: { setid?: string; title?: string; published_date?: string; spl_version?: number }[]; metadata?: { total_elements?: number | string } };
export function parseSearch(json: string, libraryDir: string): { total: number; rows: Row[] } {
  const d: J = JSON.parse(json);
  const rows: Row[] = [];
  for (const x of d.data ?? []) {
    if (!x.setid) continue;
    const [title, labeler] = splitTitle(String(x.title ?? ""));
    rows.push([x.setid, title, labeler, isoDate(x.published_date), typeof x.spl_version === "number" ? x.spl_version : null, levelOf(x.setid, libraryDir)]);
  }
  return { total: Number(d.metadata?.total_elements ?? rows.length) || rows.length, rows };
}

export type Fetch = (url: string) => Promise<string>;
const live: Fetch = (url) => fetchText(url, { "User-Agent": LIBRARY_UA, Accept: "application/json" });
export type Outcome = { ok: true; result: Result; cached: boolean } | { ok: false; error: string; input?: true };   // input: the caller's mistake, logged as error; else failed

export async function searchLabels(raw: { drug_name?: string; labeler?: string; max_results?: number }, libraryDir = FH_EVIDENCE_DIR, fetchImpl: Fetch = live): Promise<Outcome> {
  const q = normalizeQuery(raw);
  if ("error" in q) return { ok: false, error: q.error, input: true };
  const file = searchFile(libraryDir, searchKey(q));
  if (existsSync(file)) {
    try {
      const r = JSON.parse(readFileSync(file, "utf8")) as Result;
      // The listing is a week's, the level is today's
      if (daysSince(r.searched) < searchCacheDays()) return { ok: true, result: { ...r, rows: r.rows.map((row) => { const c = [...row] as Row; c[5] = levelOf(row[0], libraryDir); return c; }) }, cached: true };
    } catch { /* half a file is no file */ }
  }
  let parsed: { total: number; rows: Row[] };
  try { parsed = parseSearch(await fetchImpl(searchUrl(q)), libraryDir); } catch (e) { return { ok: false, error: `dailymed: ${e instanceof Error ? e.message : String(e)}` }; }
  const result: Result = { source: "dailymed", query: q, total: parsed.total, columns: COLUMNS, rows: parsed.rows, searched: today() };
  try { mkdirSync(dirname(file), { recursive: true }); writeAtomic(file, JSON.stringify(result, null, 2) + "\n"); } catch { /* the cache is a courtesy */ }
  return { ok: true, result, cached: false };
}
