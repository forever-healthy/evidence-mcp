// IDs are "type:value" (the CURIE convention of identifiers.org): pmid:30955454,
// pmc:PMC6521234, doi:10.1080/…, nct:05173896 (a ClinicalTrials.gov record,
// its eight digits; nct:NCT05173896 and a bare NCT05173896 are accepted),
// dailymed:<set ID> (a drug label on DailyMed). Bare digits count as pmid.
// Parsing never throws — an unusable ID comes back with an `error` so the tool
// can return it as a status instead of failing the call.

export type ParsedId = {
  requested: string;
  type: string | null;
  id: string | null;
  error?: string;   // "invalid id" (malformed; for a URL with what to use instead), "type not supported yet"
};

// A web page given as a library ID (url:https://…, or the URL itself): seen on
// two production fleets, fh_library_read on url:<page> (#49). Refused — the
// library tools take IDs, fh_fetch_url takes URLs, and a tool that accepted
// some URLs would teach the model to try more — but the answer says what to
// send instead: the record's ID when the URL names one, else fh_fetch_url.
export const URL_NOT_ID = "invalid id: a URL is not a library ID — fh_fetch_url reads a web page; library IDs are pmid:, doi:, dailymed:, nct:";
const RECORD: Record<string, string> = { pmid: "PubMed record", doi: "paper", nct: "trial record", dailymed: "drug label" };

const SUPPORTED = new Set(["pmid", "dailymed", "nct", "doi"]);
const KNOWN = new Set(["pmid", "pmc", "doi", "nct", "dailymed"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseId(raw: string): ParsedId {
  const requested = String(raw ?? "").trim();
  const url = /^(?:url:\s*)?(https?:\/\/\S+)$/i.exec(requested)?.[1];
  if (url || /^url:/i.test(requested)) {
    const rid = url ? libraryIdForUrl(url) : null;
    const type = rid?.split(":")[0] ?? "";
    return { requested, type: null, id: null, error: rid ? `invalid id: a URL is not a library ID — use ${rid} for this ${RECORD[type] ?? "record"}` : URL_NOT_ID };
  }
  const bare = /^\d+$/.test(requested);
  const bareNct = /^NCT\d{8}$/i.test(requested);           // a bare NCT ID counts as nct:
  const m = bare || bareNct ? null : /^([A-Za-z][A-Za-z0-9_-]*):(.+)$/.exec(requested);
  if (!bare && !bareNct && !m) return { requested, type: null, id: null, error: "invalid id" };

  const type = bare ? "pmid" : bareNct ? "nct" : m![1].toLowerCase();
  const value = bare || bareNct ? requested : m![2].trim();
  if (!KNOWN.has(type)) return { requested, type, id: value, error: "invalid id" };
  if (!SUPPORTED.has(type)) return { requested, type, id: value, error: "type not supported yet" };
  if (type === "doi") {
    // Lowercase (DOIs are case-insensitive), a doi.org URL or "doi:" prefix
    // inside the value dropped: doi:10.5812/asjsm.110753.
    const v = value.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim().toLowerCase();
    return /^10\.\d{4,9}\/\S+$/.test(v) ? { requested, type, id: v } : { requested, type, id: value, error: "invalid id" };
  }
  if (type === "nct") {
    // The id is the eight digits: nct:05173896 — "NCT" would only repeat the type.
    const v = value.toUpperCase().replace(/^NCT/, "");
    return /^\d{8}$/.test(v) ? { requested, type, id: v } : { requested, type, id: value, error: "invalid id" };
  }
  if (type === "dailymed") {
    const v = value.toLowerCase();
    return UUID.test(v) ? { requested, type, id: v } : { requested, type, id: value, error: "invalid id" };
  }
  if (!/^[1-9]\d*$/.test(value)) return { requested, type, id: value, error: "invalid id" };
  return { requested, type, id: value };
}

// A URL that names a library record: a PubMed, ClinicalTrials.gov, DailyMed or
// doi.org link. fh_fetch_url answers it from the library entry instead of the
// web page — PubMed's page is a script shell a browser must render, the record
// is on disk or one request away — in fetch's format, so the model changes
// nothing. null for any other URL.
export function libraryIdForUrl(raw: string): string | null {
  let u: URL; try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, ""), path = u.pathname;
  let m: RegExpExecArray | null;
  if (host === "pubmed.ncbi.nlm.nih.gov" && (m = /^\/(\d{1,8})\/?$/.exec(path))) return `pmid:${m[1]}`;
  if (host === "ncbi.nlm.nih.gov" && (m = /^\/pubmed\/(\d{1,8})\/?$/.exec(path))) return `pmid:${m[1]}`;
  if (host === "clinicaltrials.gov" && (m = /^\/(?:study|ct2\/show)\/(NCT\d{8})\/?$/i.exec(path))) return `nct:${m[1].slice(3)}`;
  if (host === "dailymed.nlm.nih.gov" && /\/(drugInfo|lookup)\.cfm$/i.test(path)) { const id = u.searchParams.get("setid"); if (id && /^[0-9a-f-]{36}$/i.test(id)) return `dailymed:${id.toLowerCase()}`; }
  if ((host === "doi.org" || host === "dx.doi.org") && (m = /^\/(10\.\S+)$/.exec(decodeURIComponent(path)))) return `doi:${m[1]}`;
  return null;
}
