import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { daysSince, today, writeAtomic } from "./entry.js";
import { fetchText, LIBRARY_UA } from "./http.js";
import { FH_EVIDENCE_DIR } from "./layout.js";

// fh_clinicaltrials_search_studies: a ClinicalTrials.gov search (API v2, no key), cached. The
// fleet's logs (2–8 Nov 2026) show what the models ask the registry for: an
// intervention or a free-text term, often only ongoing trials, a compact field
// list, 10–50 rows — to name the major ongoing trials of an intervention and
// to check a review did. A row carries what the review prompt wants said about
// a trial (AI4L ER.md, section 28): a descriptive title, the NCT ID as a link,
// participants, phase, the primary endpoint, the dates that tell whether
// "ongoing" still holds, why a trial stopped, whether results are posted. A
// row's NCT ID is a fh_library_add("nct:…") away.
//
// Cache: search/<2>/<4>/<key>.json, one file per distinct query (the file
// system as the database, like url/ and verify/), served for FH_SEARCH_CACHE_DAYS.
// A week-old listing is current enough for a review; a repeated audit within
// days reads from disk. The result JSON is the same either way.

import { settings } from "./config.js";
export const searchCacheDays = () => settings().search_cache_days;   // FH_SEARCH_CACHE_DAYS (7)
const API = "https://clinicaltrials.gov/api/v2/studies";
const FIELDS = ["NCTId", "BriefTitle", "OverallStatus", "WhyStopped", "Phase", "StudyType", "EnrollmentCount", "EnrollmentType", "StartDate", "PrimaryCompletionDate", "CompletionDate", "LastUpdatePostDate", "PrimaryOutcomeMeasure", "PrimaryOutcomeTimeFrame", "Condition", "InterventionName", "LeadSponsorName", "HasResults"];
const ONGOING = ["RECRUITING", "NOT_YET_RECRUITING", "ACTIVE_NOT_RECRUITING", "ENROLLING_BY_INVITATION"];
export const MAX_RESULTS = 100, DEFAULT_RESULTS = 20;

export type TrialsStatus = "ongoing" | "completed" | "all";
export type TrialsSort = "relevance" | "newest" | "largest" | "completion";   // the orders the live searches asked for: LastUpdatePostDate, EnrollmentCount, CompletionDate, all descending
export const SORTS: Record<TrialsSort, string | null> = { relevance: null, newest: "LastUpdatePostDate:desc", largest: "EnrollmentCount:desc", completion: "CompletionDate:desc" };
export type TrialsQuery = { query?: string; intervention?: string; condition?: string; status?: TrialsStatus; sort?: TrialsSort; max_results?: number };
// One row per trial, as an array in COLUMNS order — the field names once, not
// 20 times (#32): a listing of 20 trials is ~7k characters instead of 13.5k.
// The link is https://clinicaltrials.gov/study/<nct>; the full detail of a row
// is fh_clinicaltrials_get_study_record(nct).
export const COLUMNS = [
  "nct", "title",
  "status",              // "Terminated — slow accrual": a trial past its completion date is not "ongoing" (ER.md 28.7)
  "phase",
  "enrollment",          // "48" actual, "~100" estimated — participant count (28.5)
  "start", "primary_completion",
  "primary_outcome",     // the first primary outcome with its time frame, cut at 80 characters — the primary endpoint (28.5)
  "conditions", "interventions",   // "IVF; Infertility, Female" — one string each
  "has_results",         // posted results: get_study_results (28.8)
] as const;
export type TrialRow = [string, string, string, string | null, string | null, string | null, string | null, string | null, string | null, string | null, boolean];
export type TrialsResult = { source: "clinicaltrials"; query: Required<Pick<TrialsQuery, "status" | "sort" | "max_results">> & Pick<TrialsQuery, "query" | "intervention" | "condition">; total: number; columns: typeof COLUMNS; rows: TrialRow[]; searched: string; error?: string };

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

// The query as the cache and the API see it: trimmed text, the status word,
// the row cap in bounds. Error for an empty search.
export function normalizeQuery(q: TrialsQuery): TrialsResult["query"] | { error: string } {
  // Only the parts given are keys: a cached answer (JSON) and a fresh one must compare equal.
  const out: TrialsResult["query"] = { status: q.status ?? "all", sort: q.sort ?? "relevance", max_results: Math.min(MAX_RESULTS, Math.max(1, Math.floor(q.max_results ?? DEFAULT_RESULTS))) };
  if (clean(q.query)) out.query = clean(q.query);
  if (clean(q.intervention)) out.intervention = clean(q.intervention);
  if (clean(q.condition)) out.condition = clean(q.condition);
  if (!out.query && !out.intervention && !out.condition) return { error: "empty search: give query, intervention or condition" };
  if (!["ongoing", "completed", "all"].includes(out.status)) return { error: `status must be ongoing, completed or all, not "${String(q.status)}"` };
  if (!(out.sort in SORTS)) return { error: `sort must be relevance, newest, largest or completion, not "${String(q.sort)}"` };
  return out;
}

export const searchKey = (q: TrialsResult["query"]) => createHash("sha1").update(JSON.stringify(["clinicaltrials", q.query ?? "", q.intervention ?? "", q.condition ?? "", q.status, q.sort, q.max_results])).digest("hex").slice(0, 16);
export const searchFile = (libraryDir: string, key: string) => join(libraryDir, "search", key.slice(0, 2), key.slice(0, 4), `${key}.json`);

export function searchUrl(q: TrialsResult["query"]): string {
  const p = new URLSearchParams();
  if (q.query) p.set("query.term", q.query);
  if (q.intervention) p.set("query.intr", q.intervention);
  if (q.condition) p.set("query.cond", q.condition);
  if (q.status === "ongoing") p.set("filter.overallStatus", ONGOING.join(","));
  if (q.status === "completed") p.set("filter.overallStatus", "COMPLETED");
  if (SORTS[q.sort]) p.set("sort", SORTS[q.sort]!);
  p.set("fields", FIELDS.join(","));
  p.set("pageSize", String(q.max_results));
  p.set("countTotal", "true");
  return `${API}?${p.toString()}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const STATUS: Record<string, string> = { NOT_YET_RECRUITING: "Not yet recruiting", RECRUITING: "Recruiting", ENROLLING_BY_INVITATION: "Enrolling by invitation", ACTIVE_NOT_RECRUITING: "Active, not recruiting", SUSPENDED: "Suspended", TERMINATED: "Terminated", COMPLETED: "Completed", WITHDRAWN: "Withdrawn", UNKNOWN: "Unknown status", AVAILABLE: "Available", NO_LONGER_AVAILABLE: "No longer available", TEMPORARILY_NOT_AVAILABLE: "Temporarily not available", APPROVED_FOR_MARKETING: "Approved for marketing", WITHHELD: "Withheld" };
const PHASE: Record<string, string> = { EARLY_PHASE1: "Early Phase 1", PHASE1: "Phase 1", PHASE2: "Phase 2", PHASE3: "Phase 3", PHASE4: "Phase 4", NA: "Not applicable" };

const joined = (xs: string[]): string | null => (xs.length ? xs.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join("; ") || null : null);

export function parseRows(json: string): { total: number; rows: TrialRow[] } {
  const d: J = JSON.parse(json);
  const rows: TrialRow[] = [];
  for (const s of Array.isArray(d.studies) ? d.studies : []) {
    const p = s.protocolSection ?? {};
    const id = p.identificationModule ?? {}, st = p.statusModule ?? {}, des = p.designModule ?? {};
    const phases: string[] = Array.isArray(des.phases) ? des.phases : [];
    const nct = String(id.nctId ?? "");
    const en = des.enrollmentInfo ?? {};
    const outcomes: J[] = Array.isArray(p.outcomesModule?.primaryOutcomes) ? p.outcomesModule.primaryOutcomes : [];
    const first = outcomes[0];
    const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);
    const primary = first?.measure ? cut(`${String(first.measure).replace(/\s+/g, " ").trim()}${first.timeFrame ? ` (${String(first.timeFrame).replace(/\s+/g, " ").trim()})` : ""}`, 80) + (outcomes.length > 1 ? ` +${outcomes.length - 1}` : "") : null;
    const status = (STATUS[st.overallStatus] ?? String(st.overallStatus ?? "")) + (st.whyStopped ? ` — ${String(st.whyStopped).replace(/\s+/g, " ").trim()}` : "");
    rows.push([
      nct, String(id.briefTitle ?? ""), status,
      phases.length ? phases.map((x) => PHASE[x] ?? x).join(" / ") : null,
      typeof en.count === "number" ? `${String(en.type).toUpperCase() === "ESTIMATED" ? "~" : ""}${en.count}` : null,
      st.startDateStruct?.date ?? null, st.primaryCompletionDateStruct?.date ?? null,
      primary,
      joined(Array.isArray(p.conditionsModule?.conditions) ? p.conditionsModule.conditions.map(String) : []),
      joined(Array.isArray(p.armsInterventionsModule?.interventions) ? p.armsInterventionsModule.interventions.map((i: J) => String(i?.name ?? "")).filter(Boolean) : []),
      s.hasResults === true,
    ]);
  }
  return { total: typeof d.totalCount === "number" ? d.totalCount : rows.length, rows };
}

export type TrialsOutcome = { ok: true; result: TrialsResult; cached: boolean } | { ok: false; error: string };
export type Fetch = (url: string) => Promise<string>;
const liveFetch: Fetch = (url) => fetchText(url, { "User-Agent": LIBRARY_UA, Accept: "application/json" });

// The tool's work: a normalised query, the cached answer when younger than
// FH_SEARCH_CACHE_DAYS, else the API, stored, answered.
export async function searchTrials(raw: TrialsQuery, libraryDir = FH_EVIDENCE_DIR, fetchImpl: Fetch = liveFetch): Promise<TrialsOutcome> {
  const q = normalizeQuery(raw);
  if ("error" in q) return { ok: false, error: q.error };
  const file = searchFile(libraryDir, searchKey(q));
  if (existsSync(file)) {
    try {
      const r = JSON.parse(readFileSync(file, "utf8")) as TrialsResult;
      if (daysSince(r.searched) < searchCacheDays()) return { ok: true, result: r, cached: true };
    } catch { /* half a file is no file */ }
  }
  let json: string;
  try { json = await fetchImpl(searchUrl(q)); } catch (e) { return { ok: false, error: `clinicaltrials.gov: ${e instanceof Error ? e.message : String(e)}` }; }
  let parsed: { total: number; rows: TrialRow[] };
  try { parsed = parseRows(json); } catch { return { ok: false, error: "clinicaltrials.gov: not a studies answer" }; }
  const result: TrialsResult = { source: "clinicaltrials", query: q, total: parsed.total, columns: COLUMNS, rows: parsed.rows, searched: today() };
  try { mkdirSync(dirname(file), { recursive: true }); writeAtomic(file, JSON.stringify(result, null, 2) + "\n"); } catch { /* the cache is a courtesy */ }
  return { ok: true, result, cached: false };
}

// The log's ID column for a search: "ct:" and the first query part, cut to a
// PubMed ID's width (13) together; the tool column says "search".
export function trialsLogId(q: TrialsResult["query"]): string {
  const s = (q.intervention ?? q.condition ?? q.query ?? "").replace(/\s+/g, "_");   // one token, as the TUI's columns need
  return s.length > 10 ? s.slice(0, 9) + "…" : s || "-";
}

// ---- Design notes: Trial search — `fh_clinicaltrials_search_studies` ----
//
// The fleet's logs (2–8 Nov 2026, six hosts) show 583 `clinicaltrials_search_studies` calls, 6,629 `get_study_record` and 205 `get_study_results` (#28). Record and results are the `nct:` entry (the converter renders posted results), batch `nctIds` lookups are `fh_library_status`; only the search was missing. Of the server's 16 search parameters the models used five — `query`, `interventionQuery`, `conditionQuery`, `statusFilter` (nearly always the four "ongoing" values), `fields` (a compact list) — so `fh_clinicaltrials_search_studies` has exactly those, with a fixed row set instead of `fields`. Cached under `search/` for `FH_SEARCH_CACHE_DAYS` (7; a week-old listing is current enough for a review, repeat audits land within days). `fh_pubmed_search_articles` shares the store and the setting. Counted as `search` in `.servers/` and `fh_info`'s `cache`.
