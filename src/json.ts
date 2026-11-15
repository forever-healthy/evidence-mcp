// Answers are compact JSON (no indentation — a model reads it the same, and
// indentation was 15–30% of every answer), and status-like answers are lean:
// null values, empty arrays and the fields no consumer maps (absolute paths,
// file lists) are left out (#32). Contracts that give null a meaning
// (fh_verify_claim's score and reason) keep their nulls: they use compact only.

const DROP = new Set(["entry_dir", "evidence_dir", "files"]);

export const compact = (o: unknown): string => JSON.stringify(o);

// One level deep, as every answer is shaped: top-level fields and, for a list
// of rows, each row's fields.
export function lean<T>(o: T): T {
  if (Array.isArray(o)) return o.map((row) => (row && typeof row === "object" && !Array.isArray(row) ? leanObject(row as Record<string, unknown>) : row)) as T;
  if (o && typeof o === "object") return leanObject(o as Record<string, unknown>) as T;
  return o;
}

function leanObject(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (DROP.has(k) || v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = Array.isArray(v) ? lean(v) : v;
  }
  return out;
}

export const leanJson = (o: unknown): string => compact(lean(o));

// Per-call answers carry only what the caller did not send and does not know:
// no echo of the ID, the claim or the query, no bookkeeping dates, no default
// flags. Every tool call pays for its answer again; the session pays the tool
// list once.

// A status without the caller's own ID (requested, type, id, entry), the
// refresh bookkeeping (retrieved_date, pubmed_checked), the sources tried
// (attempts: the log has them, no audit reports them) and the declarations
// (coi, funding: often hundreds of chars on every add, read by no audit step;
// fh_library_read section "Declarations" has them whole), and title, first_author
// and doi: no audit step reads them from the status — the title match comes
// from fh_pubmed_fetch_articles; fh_library_read has the record.
const STATUS_DROP = new Set(["requested", "type", "id", "entry", "retrieved_date", "pubmed_checked", "attempts", "coi", "funding", "title", "first_author", "doi"]);
export function statusAnswer(s: Record<string, unknown>): string {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (!STATUS_DROP.has(k)) o[k] = v;
  if (Array.isArray(o.publication_types)) o.publication_types = reviewTypes(o.publication_types as string[]);
  return leanJson(o);
}

// A verdict: verdict, score (two decimals; null means no judgement) and basis
// always; reason and error when set, superseded when true, glyphs_unresolved
// when above 0. Not the claim, the ID or the model (fh_info names it).
export function verdictAnswer(r: { verdict: string; score: number | null; basis?: string | null; reason?: string | null; error?: string | null; superseded?: boolean | null; glyphs_unresolved?: number | null }): string {
  if (r.error) return compact({ verdict: "error", error: r.error });
  const o: Record<string, unknown> = { verdict: r.verdict, score: r.score === null ? null : Math.round(r.score * 100) / 100, basis: r.basis ?? null };
  if (r.reason) o.reason = r.reason;
  if (r.superseded) o.superseded = true;
  if (r.glyphs_unresolved) o.glyphs_unresolved = r.glyphs_unresolved;
  return compact(o);
}

// A read answer without the caller's ID and without partial: false.
export function readAnswer(o: Record<string, unknown>): string {
  const { requested: _r, entry: _e, ...rest } = o;
  if (rest.partial === false) delete rest.partial;
  return leanJson(rest);
}

// A search answer: total, columns, rows — not the query the caller sent.
export function searchAnswer(r: { total: number; columns: readonly string[]; rows: unknown[] }): string {
  return compact({ total: r.total, columns: r.columns, rows: r.rows });
}

// Publication types a review weighs: not the default "Journal Article" nor
// the funding notes ("Research Support, N.I.H., Extramural").
export const reviewTypes = (types: string[]): string[] => types.filter((t) => t !== "Journal Article" && !/^Research Support\b/.test(t));
