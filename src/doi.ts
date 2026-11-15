import { contactEmail } from "./contact.js";
import { fetchText, LIBRARY_UA } from "./http.js";
import type { Correction, CorrectionType, PubmedRecord } from "./pubmed.js";

// Papers PubMed does not index, by DOI: the
// record comes from Crossref and is shaped like a PubMed record, so the entry,
// the abstract, the meta and the full-text cascade work as for a pmid: entry.
// A DOI that PubMed does index is not stored twice: fh_library_add resolves it
// to its PMID and builds that entry.

const NCBI_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";

// The PMID of a DOI, when PubMed indexes it under that DOI exactly once.
export async function pmidForDoi(doi: string): Promise<string | null> {
  const u = new URL(NCBI_ESEARCH);
  u.searchParams.set("db", "pubmed"); u.searchParams.set("term", `${doi}[doi]`); u.searchParams.set("retmode", "json");
  if (process.env.FH_NCBI_API_KEY) u.searchParams.set("api_key", process.env.FH_NCBI_API_KEY);
  u.searchParams.set("tool", "evidence-mcp"); u.searchParams.set("email", contactEmail());
  const j = JSON.parse(await fetchText(u.toString())) as { esearchresult?: { idlist?: string[] } };
  const ids = j.esearchresult?.idlist ?? [];
  return ids.length === 1 ? ids[0] : null;
}

// The Crossref record as JSON text, or null for a DOI Crossref does not know.
export async function fetchCrossref(doi: string): Promise<string | null> {
  try {
    return await fetchText(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(contactEmail())}`, { "User-Agent": LIBRARY_UA });
  } catch (e) {
    if (/HTTP 404/.test(e instanceof Error ? e.message : String(e))) return null;
    throw new Error(`crossref fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Crossref's work types in PubMed's words, so publication_types reads the same.
const TYPES: Record<string, string> = {
  "journal-article": "Journal Article", "proceedings-article": "Conference Paper", "posted-content": "Preprint",
  "book-chapter": "Book Chapter", "book": "Book", "monograph": "Book", "report": "Report", "dissertation": "Dissertation",
  "peer-review": "Peer Review", "dataset": "Dataset", "other": "Other",
};
// Crossref update notices ("updated-by") in the corrections vocabulary.
const UPDATES: Record<string, CorrectionType> = {
  retraction: "retraction_in", withdrawal: "retraction_in", removal: "retraction_in", "partial-retraction": "partial_retraction_in",
  correction: "erratum_in", erratum: "erratum_in", corrigendum: "erratum_in", clarification: "erratum_in", addendum: "erratum_in",
  "expression-of-concern": "expression_of_concern_in", "new-version": "update_in",
};

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
export function parseCrossref(json: string): PubmedRecord | null {
  let m: J; try { m = JSON.parse(json)?.message; } catch { return null; }
  if (!m?.DOI) return null;
  const authors: string[] = (m.author ?? []).map((a: J) => a.family ? [a.family, String(a.given ?? "").split(/[\s-]+/).filter(Boolean).map((g: string) => g[0]).join("")].filter(Boolean).join(" ") : a.name ?? "").filter(Boolean);
  const first = (m.author ?? [])[0];
  const date = m.issued?.["date-parts"]?.[0] ?? m.published?.["date-parts"]?.[0] ?? m.created?.["date-parts"]?.[0];
  // A structured JATS abstract keeps its section titles as labels.
  const abstract: { label: string | null; text: string }[] = [];
  const raw = String(m.abstract ?? "");
  const secs = [...raw.matchAll(/<jats:sec>\s*(?:<jats:title>([\s\S]*?)<\/jats:title>)?([\s\S]*?)<\/jats:sec>/g)];
  if (secs.length) for (const s of secs) { const t = text(s[2]); if (t) abstract.push({ label: s[1] ? text(s[1]).replace(/[:.]$/, "") : null, text: t }); }
  else { const t = text(raw.replace(/<jats:title>[\s\S]*?<\/jats:title>/, "")); if (t) abstract.push({ label: null, text: t }); }
  const corrections: Correction[] = (m["updated-by"] ?? []).flatMap((u: J) => {
    const type = UPDATES[String(u.type ?? "").toLowerCase()];
    return type ? [{ type, pmid: null, source: `${u.label ?? u.type}: doi:${u.DOI}${u.updated?.["date-time"] ? ` (${String(u.updated["date-time"]).slice(0, 10)})` : ""}` }] : [];
  });
  const funding: string[] = [];
  for (const f of m.funder ?? []) { const n = text(String(f.name ?? "")); if (n && !funding.includes(n)) funding.push(n); }
  return {
    pmid: "", pmcid: null, doi: String(m.DOI).toLowerCase(),
    title: text(String((m.title ?? [])[0] ?? "")) || String(m.DOI),
    authors, firstAuthor: first ? (first.family ?? first.name ?? null) : null,
    journal: text(String((m["container-title"] ?? [])[0] ?? "")) || m.publisher || null,
    year: date?.[0] ? String(date[0]) : null,
    publicationTypes: [TYPES[m.type] ?? "Other"],
    abstract, corrections, coi: null, funding,
  };
}

// OpenAlex's abstract for a DOI, rebuilt from its inverted index (word →
// positions), when Crossref has none: of the 97 DOI-only papers a production fleet
// cites, Crossref carries 55 abstracts, OpenAlex 86.
export function fromInvertedIndex(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [w, ps] of Object.entries(index)) for (const p of ps) words[p] = w;
  return words.filter((w) => w !== undefined).join(" ").replace(/\s+([.,;:!?)])/g, "$1").replace(/\(\s+/g, "(").trim();
}
export async function openAlexAbstract(doi: string): Promise<string> {
  try {
    const j = JSON.parse(await fetchText(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(contactEmail())}&select=abstract_inverted_index`, { "User-Agent": LIBRARY_UA })) as { abstract_inverted_index?: Record<string, number[]> };
    return fromInvertedIndex(j.abstract_inverted_index);
  } catch { return ""; }
}

// A DOI another registry holds (DataCite, mEDRA, …): doi.org's content
// negotiation answers CSL JSON for every registry. Used when Crossref does not
// know the DOI; null when doi.org does not either.
export async function fetchCsl(doi: string): Promise<string | null> {
  try {
    const r = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, { headers: { Accept: "application/vnd.citationstyles.csl+json", "User-Agent": LIBRARY_UA }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    const t = await r.text();
    return /^\s*\{/.test(t) ? t : null;
  } catch { return null; }
}
const CSL_TYPES: Record<string, string> = { "article-journal": "Journal Article", "paper-conference": "Conference Paper", chapter: "Book Chapter", book: "Book", report: "Report", thesis: "Dissertation", "posted-content": "Preprint", article: "Preprint", dataset: "Dataset" };
export function parseCsl(json: string): PubmedRecord | null {
  let m: J; try { m = JSON.parse(json); } catch { return null; }
  if (!m?.DOI && !m?.title) return null;
  const people: J[] = m.author ?? m.editor ?? [];
  const authors = people.map((a: J) => a.family ? [a.family, String(a.given ?? "").split(/[\s.-]+/).filter(Boolean).map((g: string) => g[0]).join("")].filter(Boolean).join(" ") : a.literal ?? a.name ?? "").filter(Boolean);
  const date = m.issued?.["date-parts"]?.[0] ?? m.published?.["date-parts"]?.[0];
  const abs = text(String(m.abstract ?? ""));
  return {
    pmid: "", pmcid: null, doi: String(m.DOI ?? "").toLowerCase(),
    title: text(String(Array.isArray(m.title) ? m.title[0] : m.title ?? "")) || String(m.DOI),
    authors, firstAuthor: people[0] ? (people[0].family ?? people[0].literal ?? null) : null,
    journal: text(String(Array.isArray(m["container-title"]) ? m["container-title"][0] ?? "" : m["container-title"] ?? "")) || m.publisher || null,
    year: date?.[0] ? String(date[0]) : null,
    publicationTypes: [CSL_TYPES[m.type] ?? "Other"],
    abstract: abs ? [{ label: null, text: abs }] : [], corrections: [], coi: null, funding: [],
  };
}

// ---- Design notes: DOI entries — a PubMed-indexed DOI is stored twice ----
//
// A review may cite a paper by DOI that PubMed indexes (5 of the 101 DOI-only
// citations in production reviews, 2026-11-06: four Bookshelf records and
// one recent paper). Decided 2026-11-06: such a paper is stored twice — its
// `pmid:` entry, and a copy of it under `doi:`.
//
// **What was there first.** `fh_library_add("doi:X")` mapped the DOI to its PMID
// (esearch `X[doi]`) and built the `pmid:` entry only; `fh_library_status`,
// `fh_library_read` and `fh_verify_claim` resolved a DOI through the same lookup
// (`resolveDoi`, cached per process). Rejected: a read or a verify went to
// PubMed for an entry on disk, the first call after every restart, and with
// PubMed unreachable a stored paper read as missing. Also considered: a
// one-line pointer file in the `doi:` slot (`pmid:NNN`) — local, no
// duplication, but the slot is then not an entry and every reader needs one
// indirection.
//
// **How it works.**
//
// * `fh_library_add("doi:X")`: a `doi:` entry whose meta carries a `pmid` is a copy
//   → run the `pmid:` path on that PMID (idempotent: no calls for an existing
//   entry beyond the cooldown retries and the 30-day record refresh), then copy
//   again. No `doi:` entry → ask PubMed once (`pmidForDoi`); a PMID whose record
//   the library cannot read is dropped and the DOI stays a Crossref entry
//   (`kept as doi:`). A PMID → build or complete the `pmid:` entry, then
//   `copyEntry` (src/entry.ts): the target directory is removed and rebuilt,
//   every file copied with the prefix renamed (`pmid-33052641-fulltext.md` →
//   `doi-10.22427_ntp-dart-04-fulltext.md`), the meta written last with `files`
//   renamed and `pmid` kept. The status returned is the copy's (`type` doi,
//   `entry` `doi-…`, `pmid` set).
// * `fh_library_status`, `fh_library_read`, `fh_verify_claim`: read the `doi:` entry,
//   nothing else. No lookup, no cache, no network.
// * The copy is as current as its original at the last `fh_library_add` of the
//   DOI. A later `fh_library_add("pmid:NNN")` that finds a full text does not touch
//   the copy; the next add of the DOI does. The audit adds every ID it cites
//   before verifying, so the copy it verifies against was synced in the same run.
//
// **Cost.** Disk twice for a mapped paper (five today); `fh_info` counts it
// under `pmid` and under `doi`. A `doi:` entry with `pmid` set is a copy, one
// with `pmid` empty is a Crossref/doi.org entry — the one field that tells them
// apart.
//
