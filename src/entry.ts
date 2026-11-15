import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { basename, dirname } from "node:path";
import type { EntryPaths } from "./layout.js";
import { isRetractionNotice, parsePubmedXml, type Correction, type CorrectionType, type PubmedRecord } from "./pubmed.js";
import type { TierHit } from "./tiers/tier.js";
import { renderLabelMd, type SplDoc } from "./spl.js";
import { renderStudyMd, type StudyDoc } from "./ctgov.js";
import { countUnresolved } from "./pdf.js";

// An entry on disk and the status that describes it. The status is what every
// tool returns; its fields are those of <type>-<id>-meta.md plus what was asked
// for (src/layout.ts). Absent values are null, never missing.

export type Level = "abstract" | "full_text";

// The frontmatter of <type>-<id>-meta.md, keys in this order.
export type Meta = {
  pmid: string;                  // "" for a drug label
  setid: string | null;          // DailyMed set ID of a drug label; null otherwise
  nctid: string | null;          // ClinicalTrials.gov ID of a trial record; null otherwise
  publications: string[];        // a trial record's results publications, "pmid:…" (references typed RESULT or DERIVED)
  pmcid: string | null;
  doi: string | null;
  title: string;
  first_author: string | null;
  year: string | null;
  publication_types: string[];
  retracted: boolean;            // "Retracted Publication" type, or a retraction notice in corrections
  corrections: Correction[];     // PubMed's notices about this paper
  coi: string | null;            // PubMed's conflict-of-interest statement, verbatim; null when the record has none
  funding: string[];             // PubMed's grant agencies; [] when the record lists none
  has_abstract: boolean;         // PubMed carries abstract text (letters, editorials, old papers often have none)
  level: Level;
  version: string | null;        // of the full text: published | accepted_manuscript | preprint
  files: string[];
  retrieved_by: string;          // tier that produced the current level
  retrieved_date: string;
  converted_by: string;
  pubmed_checked: string;        // date the PubMed record was last read (ingest or refresh)
  attempts: string[];            // failed tiers, "<tier> (<reason>)"
};

export type Status = {
  requested: string;
  type: string | null;
  id: string | null;
  entry: string | null;
  entry_dir: string | null;
  evidence_dir: string;
  pmid: string | null;
  setid: string | null;          // a drug label's DailyMed set ID; null otherwise
  nctid: string | null;          // a trial record's ClinicalTrials.gov ID; null otherwise
  publications: string[];        // a trial record's results publications as "pmid:…"; [] otherwise
  pmcid: string | null;
  doi: string | null;
  title: string | null;
  first_author: string | null;
  year: string | null;
  publication_types: string[];
  retracted: boolean;
  corrections: Correction[];
  coi: string | null;
  funding: string[];
  citable: boolean;              // the one flag for the auditor: false when retracted
  comment: string | null; // why not citable; or, when citable, a notice to be aware of
  has_abstract: boolean | null;
  level: Level | "title" | "missing" | null;   // "title": no full text and no abstract text
  version: string | null;
  retrieved_by: string | null;
  retrieved_date: string | null;
  pubmed_checked: string | null;
  attempts: string[];
  files: string[];
  glyphs_unresolved: number | null;   // control characters in the full text where a font gave no symbol (−, ±, ≤ …); null without full text
  error?: string;
};

export function emptyStatus(requested: string, type: string | null, id: string | null, libraryDir: string): Status {
  return {
    requested, type, id, entry: null, entry_dir: null, evidence_dir: libraryDir,
    pmid: null, setid: null, nctid: null, publications: [], pmcid: null, doi: null, title: null, first_author: null, year: null,
    publication_types: [], retracted: false, corrections: [], coi: null, funding: [], citable: true, comment: null,
    has_abstract: null, level: null, version: null,
    retrieved_by: null, retrieved_date: null, pubmed_checked: null, attempts: [], files: [], glyphs_unresolved: null,
  };
}

export const today = () => new Date().toISOString().slice(0, 10);
// A cooldown's start to the second, UTC ("2026-11-09T00:07:00Z"). A bare date
// counts from midnight UTC: a failure at 23:53 UTC was "a day old" 13 minutes
// later and retried (a dev deployment, 2026-11-09). daysSince reads both forms.
export const now = () => new Date().toISOString().slice(0, 19) + "Z";

// --- Markdown ---------------------------------------------------------------

// The metadata line under the title, shared by abstract.md and fulltext.md.
export function headLine(r: PubmedRecord): string {
  return [
    r.authors.join(", ") || null,
    r.journal,
    r.year,
    r.pmid ? `PMID ${r.pmid}` : "not in PubMed",
    r.doi ? `DOI ${r.doi}` : null,
    r.pmcid ? `PMCID ${r.pmcid}` : null,
  ].filter(Boolean).join(" · ");
}

export function renderAbstractMd(r: PubmedRecord): string {
  const body = r.abstract.length
    ? r.abstract.map((a) => (a.label ? `**${a.label}.** ${a.text}` : a.text)).join("\n\n")
    : "_No abstract available._";
  return `# ${r.title}\n\n${headLine(r)}\n\n## Abstract\n\n${body}\n`;
}

// The head line of an existing entry, read back from its abstract.md (the
// second non-empty line) so a later full text gets the same one.
export function readHeadLine(p: EntryPaths): string {
  try {
    const lines = readFileSync(p.md, "utf8").split("\n").filter((l) => l.trim());
    return lines[1] ?? "";
  } catch { return ""; }
}

// --- meta.md ----------------------------------------------------------------

export function metaFromRecord(r: PubmedRecord, files: string[], converter: string): Meta {
  return {
    pmid: r.pmid, setid: null, nctid: null, publications: [], pmcid: r.pmcid, doi: r.doi, title: r.title, first_author: r.firstAuthor, year: r.year,
    publication_types: r.publicationTypes,
    retracted: isRetracted(r),
    corrections: r.corrections,
    coi: r.coi, funding: r.funding,
    has_abstract: r.abstract.length > 0,
    level: "abstract", version: null, files,
    retrieved_by: "pubmed", retrieved_date: today(), converted_by: converter, pubmed_checked: today(), attempts: [],
  };
}

// Retracted by either source: the publication type, or a retraction notice.
const isRetracted = (r: PubmedRecord) => r.publicationTypes.includes("Retracted Publication") || r.corrections.some(isRetractionNotice);

// One line per notice: "<type> <pmid or -> <source JSON-quoted>" — the source
// holds commas, semicolons and dots, so it is quoted, never joined.
export const renderCorrection = (c: Correction) => `${c.type} ${c.pmid ?? "-"} ${JSON.stringify(c.source)}`;
export function parseCorrection(v: string): Correction | null {
  const m = /^(\S+) (\S+) ("[\s\S]*")$/.exec(v.trim());
  if (!m) return null;
  let source: string;
  try { source = JSON.parse(m[3]); } catch { return null; }
  return { type: m[1] as CorrectionType, pmid: m[2] === "-" ? null : m[2], source };
}

export function renderMeta(m: Meta): string {
  const lines: [string, string][] = [
    ["pmid", m.pmid],
    ...(m.setid ? [["setid", m.setid] as [string, string]] : []),
    ...(m.nctid ? [["nctid", m.nctid] as [string, string]] : []),
    ...(m.nctid ? [["publications", m.publications.join(", ")] as [string, string]] : []),
    ["pmcid", m.pmcid ?? ""],
    ["doi", m.doi ?? ""],
    ["title", JSON.stringify(m.title)],
    ["first_author", m.first_author ?? ""],
    ["year", m.year ?? ""],
    ["publication_types", m.publication_types.join("; ")],
    ["retracted", m.retracted ? "yes" : "no"],
    ...m.corrections.map((c): [string, string] => ["corrections", renderCorrection(c)]),
    ["coi", m.coi === null ? "" : JSON.stringify(m.coi)],
    ["funding", m.funding.length ? JSON.stringify(m.funding) : ""],   // a JSON array: a statement may hold semicolons
    ["has_abstract", m.has_abstract ? "yes" : "no"],
    ["level", m.level],
    ["version", m.version ?? ""],
    ["files", m.files.join(", ")],
    ["retrieved_by", m.retrieved_by],
    ["retrieved_date", m.retrieved_date],
    ["converted_by", m.converted_by],
    ["pubmed_checked", m.pubmed_checked],
    ["attempts", m.attempts.join(", ")],
  ];
  return "---\n" + lines.map(([k, v]) => (v === "" ? `${k}:` : `${k}: ${v}`)).join("\n") + "\n---\n";
}

// A key may repeat (corrections: one line per notice): `all` keeps every value.
function parseFrontmatter(md: string): { fm: Record<string, string>; all: Record<string, string[]> } {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const fm: Record<string, string> = {}, all: Record<string, string[]> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    fm[k] = v;
    (all[k] ??= []).push(v);
  }
  return { fm, all };
}

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

// Attempts are joined with ", " but a reason may itself hold commas ("no
// article body (html, 693 words, 16 headings)"), so split only where the
// parentheses are balanced, and glue any piece that is not "<tier> (…)" back
// onto its predecessor — a cut inside a reason once made the whole tdm attempt
// invisible to the retry rule (the fragments parse as nothing) and showed up as
// seven entries in the status.
export function splitAttempts(v: string | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  let cur = "", depth = 0;
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  const merged: string[] = [];
  for (const piece of out.map((s) => s.trim()).filter(Boolean)) {
    if (merged.length && !/^\S+ \(/.test(piece)) merged[merged.length - 1] += ", " + piece;
    else merged.push(piece);
  }
  return merged;
}
const opt = (v: string | undefined) => (v ? v : null);

// PubMed publication types are written "; "-separated, since a dozen of them
// carry commas ("Research Support, Non-U.S. Gov't", "Clinical Trial, Phase
// II"). Entries written with ", " are read back by gluing the known second
// and third parts onto the type before them.
const TYPE_CONTINUATION = new Set(["N.I.H.", "Extramural", "Intramural", "Non-U.S. Gov't", "U.S. Gov't", "U.S. Government", "P.H.S.", "Non-P.H.S.", "Phase I", "Phase II", "Phase III", "Phase IV", "Veterinary", "NIH", "American Recovery and Reinvestment Act"]);
export function splitPublicationTypes(v: string | undefined): string[] {
  if (!v) return [];
  if (v.includes(";")) return v.split(";").map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const piece of list(v)) {
    if (out.length && TYPE_CONTINUATION.has(piece)) out[out.length - 1] += ", " + piece;
    else out.push(piece);
  }
  return out;
}

// Entries written before has_abstract existed: read it off abstract.md.
function abstractMissing(p: EntryPaths): boolean {
  try { return readFileSync(p.md, "utf8").includes("_No abstract available._"); } catch { return false; }
}

// Entries written before corrections existed (no pubmed_checked line): the
// notices come from the stored PubMed XML, and the record counts as checked
// on the entry's retrieval date.
function correctionsFromXml(p: EntryPaths): Correction[] {
  try { return parsePubmedXml(readFileSync(p.xml, "utf8"))?.corrections ?? []; } catch { return []; }
}
// Entries written before coi/funding existed (no coi line): read from the XML.
function declarationsFromXml(p: EntryPaths): { coi: string | null; funding: string[] } {
  try { const r = parsePubmedXml(readFileSync(p.xml, "utf8")); return { coi: r?.coi ?? null, funding: r?.funding ?? [] }; } catch { return { coi: null, funding: [] }; }
}

export function readMeta(p: EntryPaths): Meta {
  const { fm, all } = parseFrontmatter(readFileSync(p.meta, "utf8"));
  let title = fm.title ?? "";
  if (title.startsWith('"')) { try { title = JSON.parse(title); } catch { /* keep raw */ } }
  const legacy = fm.pubmed_checked === undefined;
  const corrections = legacy ? correctionsFromXml(p) : (all.corrections ?? []).map(parseCorrection).filter((c): c is Correction => c !== null);
  let coi: string | null = null, funding: string[] = [];
  if (fm.coi === undefined) ({ coi, funding } = declarationsFromXml(p));
  else { if (fm.coi.startsWith('"')) { try { coi = JSON.parse(fm.coi); } catch { coi = fm.coi; } } else coi = fm.coi || null; funding = !fm.funding ? [] : fm.funding.startsWith("[") ? (JSON.parse(fm.funding) as string[]) : fm.funding.split(";").map((s) => s.trim()).filter(Boolean); }
  return {
    pmid: fm.pmid ?? "", setid: opt(fm.setid), nctid: opt(fm.nctid), publications: list(fm.publications), pmcid: opt(fm.pmcid), doi: opt(fm.doi), title,
    first_author: opt(fm.first_author), year: opt(fm.year),
    publication_types: splitPublicationTypes(fm.publication_types),
    retracted: fm.retracted === "yes" || corrections.some(isRetractionNotice),
    corrections, coi, funding,
    has_abstract: fm.has_abstract ? fm.has_abstract === "yes" : !abstractMissing(p),
    level: (fm.level === "full_text" ? "full_text" : "abstract"),
    version: opt(fm.version), files: list(fm.files),
    retrieved_by: fm.retrieved_by ?? "", retrieved_date: fm.retrieved_date ?? "",
    converted_by: fm.converted_by ?? "", pubmed_checked: legacy ? (fm.retrieved_date ?? "") : fm.pubmed_checked,
    attempts: splitAttempts(fm.attempts),
  };
}

// Every entry file is written to a temporary name beside it and renamed into
// place: several servers write one library (a fleet of review workers, one sidecar
// per worker), and a reader must never see a half-written file. Two servers
// writing the same entry at once write the same bytes twice; no lock.
export function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function writeMeta(p: EntryPaths, m: Meta): void {
  writeAtomic(p.meta, renderMeta(m));
  try { unlinkSync(join(p.entryDir, `${p.entry}-missing.md`)); } catch { /* no not-found marker to replace (src/missing.ts) */ }
}

// A paper stored twice: a DOI PubMed indexes gets its pmid: entry copied
// under doi:, every file renamed to the copy's prefix, so the DOI resolves on
// disk with no lookup. The copy is rebuilt from scratch on each fh_library_add
// of the DOI; its meta is written last, like any entry's.
export function copyEntry(from: EntryPaths, to: EntryPaths): Meta {
  // Built beside the entry and swapped in, so a reader sees the old copy or the new one, never a half.
  const tmp = `${to.entryDir}.${process.pid}.tmp`, old = `${to.entryDir}.${process.pid}.old`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const rename = (n: string) => (n.startsWith(from.entry) ? to.entry + n.slice(from.entry.length) : n);
  for (const n of readdirSync(from.entryDir)) if (join(from.entryDir, n) !== from.meta && !n.endsWith(".tmp")) copyFileSync(join(from.entryDir, n), join(tmp, rename(n)));
  const m = readMeta(from);
  const copy = { ...m, files: m.files.map(rename) };
  writeFileSync(join(tmp, basename(to.meta)), renderMeta(copy));
  mkdirSync(dirname(to.entryDir), { recursive: true });
  if (existsSync(to.entryDir)) renameSync(to.entryDir, old);
  renameSync(tmp, to.entryDir);
  rmSync(old, { recursive: true, force: true });
  return copy;
}

// citable is the one thing the auditor checks; the comment explains it. Not
// citable: retracted (a retraction notice's citation, else the publication
// type), or nothing to read (title only). Citable with a comment: an erratum (its severity is not assessed yet),
// an expression of concern, a newer version that supersedes this one.
// A record with nothing to read — no abstract text and no full text — is not
// evidence: nothing about it can be verified. A full text found later makes it citable.
export const NOTHING_TO_VERIFY = "no abstract and no full text: nothing to verify";

export function citability(m: Meta): { citable: boolean; comment: string | null } {
  const of = (t: Correction["type"]) => m.corrections.filter((c) => c.type === t);
  const cite = (c: Correction) => `${c.source}${c.pmid ? ` (pmid:${c.pmid})` : ""}`;
  if (m.retracted) {
    const r = m.corrections.filter(isRetractionNotice);
    return { citable: false, comment: r.length ? `retracted: ${r.map(cite).join("; ")}` : "retracted (PubMed publication type)" };
  }
  if (m.level !== "full_text" && !m.has_abstract) return { citable: false, comment: NOTHING_TO_VERIFY };
  const notes = [
    ...of("erratum_in").map((c) => `erratum, not assessed: ${cite(c)}`),
    ...of("expression_of_concern_in").map((c) => `expression of concern: ${cite(c)}`),
    ...of("update_in").map((c) => `superseded by a newer version: ${cite(c)}`),
  ];
  return { citable: true, comment: notes.length ? notes.join("; ") : null };
}

export function statusFromMeta(p: EntryPaths, m: Meta, base: Status): Status {
  const full = existsSync(p.fulltextMd) ? readFileSync(p.fulltextMd, "utf8") : null;
  const cit = citability(m);
  // An erratum whose corrected sentences are stored is no longer "not assessed".
  if (full?.includes(`\n${CORRECTED_HEADING}\n`) && cit.comment) cit.comment = cit.comment.replace(/erratum, not assessed: /g, "erratum, corrected figures stored (Corrected in PubMed abstract): ");
  return {
    ...base,
    entry: p.entry, entry_dir: p.entryDir,
    pmid: m.pmid || null, setid: m.setid, nctid: m.nctid, publications: m.publications, pmcid: m.pmcid, doi: m.doi, title: m.title || null,
    first_author: m.first_author, year: m.year, publication_types: m.publication_types,
    retracted: m.retracted, corrections: m.corrections, coi: m.coi, funding: m.funding, ...cit,
    // What the entry holds: full_text, abstract, or only the title (the meta's
    // level is "abstract" until a full text arrives; has_abstract says whether
    // there is abstract text).
    has_abstract: m.has_abstract, level: m.level === "abstract" && !m.has_abstract ? "title" : m.level, version: m.version,
    retrieved_by: m.retrieved_by || null, retrieved_date: m.retrieved_date || null, pubmed_checked: m.pubmed_checked || null,
    attempts: m.attempts, files: m.files,
    glyphs_unresolved: full === null ? null : countUnresolved(full),
  };
}

export function readStatus(p: EntryPaths, base: Status): Status {
  return statusFromMeta(p, readMeta(p), base);
}

// --- disk -------------------------------------------------------------------

export function entryExists(p: EntryPaths): boolean {
  return existsSync(p.meta);
}

// meta.md is written last: a half-written entry has no meta and is rebuilt on
// the next call.
export function writeEntry(p: EntryPaths, r: PubmedRecord, xml: string, converter: string): Meta {
  mkdirSync(p.entryDir, { recursive: true });
  writeAtomic(p.xml, xml);
  writeAtomic(p.md, renderAbstractMd(r));
  const meta = metaFromRecord(r, [basename(p.xml), basename(p.md)], converter);
  writeMeta(p, meta);
  return meta;
}

// A re-read PubMed record: the XML is replaced and
// the record's facts in meta updated — notices, retraction, publication types,
// an identifier that appeared since. The abstract Markdown, the full text and
// the attempts are not touched.
export function refreshRecord(p: EntryPaths, m: Meta, r: PubmedRecord, xml: string): Meta {
  writeAtomic(p.xml, xml);
  syncCorrectedBlock(p);   // a correction that appeared since reaches the full text too
  const next: Meta = {
    ...m,
    pmcid: r.pmcid ?? m.pmcid, doi: r.doi ?? m.doi,
    publication_types: r.publicationTypes, retracted: isRetracted(r), corrections: r.corrections,
    coi: r.coi ?? m.coi, funding: r.funding.length ? r.funding : m.funding,   // the paper's own statements stay when PubMed has none
    pubmed_checked: today(),
  };
  writeMeta(p, next);
  return next;
}

// Days since a YYYY-MM-DD date; Infinity when there is none.
export function daysSince(date: string, now = new Date()): number {
  const t = new Date(date).getTime();
  return Number.isFinite(t) ? (now.getTime() - t) / 86_400_000 : Infinity;
}

// A full text from a tier: original + Markdown stored, meta upgraded. Files
// first, meta last (same half-written rule as above).
// The paper's own funding and conflict statements from its Markdown: the
// Declarations section (JATS) and body sections headed Funding, Conflicts of
// interest, Competing interests, Disclosure. Used only where PubMed's record
// has none, so a status never says "no funding" for a paper whose text names
// its grant — a reader of the status alone would conclude the opposite.
const FUNDING_RE = /^[*_\s]*(funding|financial support|sources? of (financial )?support|support(ed by)?|grant support|this (work|study|research) was (supported|funded))\b[^:]*:?[*_\s]*(.*)$/i;
const COI_RE = /^[*_\s]*(conflicts? of interest|competing interests?|disclosures?|financial disclosures?|declarations? of (competing |conflicting )?interests?|conflict[- ]of[- ]interest statement)\b[^:]*:?[*_\s]*(.*)$/i;
export function declarationsFromMd(md: string): { coi: string | null; funding: string[] } {
  let coi: string | null = null; const funding: string[] = [];
  const lines = md.split("\n");
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const h = /^#{2,6}\s+(.*)$/.exec(l);
    if (h) {
      section = h[1];
      // A section headed with the keyword: its first paragraph is the statement.
      const body = lines.slice(i + 1).find((x) => x.trim() && !/^#/.test(x))?.trim() ?? "";
      if (body && /^(funding|financial support|sources? of funding|role of the funding source)/i.test(section) && !funding.length) funding.push(body);
      if (body && /^(conflicts? of interest|competing interests?|disclosures?|financial disclosures?|declarations? of (competing |conflicting )?interests?)/i.test(section) && coi === null) coi = body;
      continue;
    }
    if (section !== "Declarations" || !l) continue;
    const f = FUNDING_RE.exec(l); const c = COI_RE.exec(l);
    if (c && c[3]?.trim() && coi === null) coi = c[3].trim().replace(/[*_]+$/, "");
    else if (f && f[6]?.trim() && !funding.length) funding.push(f[6].trim().replace(/[*_]+$/, ""));
  }
  return { coi, funding };
}

// Corrected in PubMed's abstract: NLM updates the abstract after an erratum
// and marks each corrected sentence "[corrected]"; a full text fetched from
// the publisher often predates it (DETAIL, pmid:15516696: the 2004 PDF has
// −17.9, the abstract −17.5 [corrected]). Those sentences are copied to the
// end of the full text under one fixed heading, so fh_verify_claim and
// fh_library_read see the corrected figures next to the original ones.
export const CORRECTED_HEADING = "## Corrected in PubMed abstract";
export function correctedSentences(r: PubmedRecord): string[] {
  const out: string[] = [];
  for (const a of r.abstract) {
    for (const s of a.text.split(/(?<=[.!?\]])\s+(?=[A-Z(\u2212-])/)) {
      const i = s.indexOf("[corrected]");
      if (i >= 0) out.push(s.slice(0, i).trim().replace(/\s+([.,;])$/, "$1"));
    }
  }
  return out.filter(Boolean);
}
export function withCorrectedBlock(md: string, sentences: string[]): string {
  const base = md.split(`\n${CORRECTED_HEADING}\n`)[0].trimEnd();
  if (!sentences.length) return base + "\n";
  return `${base}\n\n${CORRECTED_HEADING}\n\nNLM corrected these sentences of the abstract after an erratum; the text above may predate the correction.\n\n${sentences.join("\n\n")}\n`;
}
// The block brought up to date with the stored PubMed record; a no-op for an
// entry without full text, without a record, or without corrected sentences.
export function syncCorrectedBlock(p: EntryPaths): void {
  if (!existsSync(p.fulltextMd) || !existsSync(p.xml)) return;
  let r: PubmedRecord | null; try { r = parsePubmedXml(readFileSync(p.xml, "utf8")); } catch { return; }
  if (!r) return;
  const md = readFileSync(p.fulltextMd, "utf8");
  const next = withCorrectedBlock(md, correctedSentences(r));
  if (next !== md) writeAtomic(p.fulltextMd, next);
}

export function applyFulltext(p: EntryPaths, m: Meta, hit: TierHit, converter: string): Meta {
  const raw = p.fulltextRaw(hit.format);
  writeAtomic(raw, hit.raw);
  writeAtomic(p.fulltextMd, hit.md);
  syncCorrectedBlock(p);
  const files = [...m.files.filter((f) => !f.includes("-fulltext.")), basename(raw), basename(p.fulltextMd)];
  const own = declarationsFromMd(hit.md);
  const next: Meta = { ...m, level: "full_text", version: hit.version, files, retrieved_by: hit.tier, retrieved_date: today(), converted_by: converter,
    coi: m.coi ?? own.coi, funding: m.funding.length ? m.funding : own.funding };
  writeMeta(p, next);
  return next;
}

// A new attempt for a tier replaces that tier's earlier entry (a retry).
export function recordAttempts(p: EntryPaths, m: Meta, labels: string[]): Meta {
  if (!labels.length) return m;
  const tierOf = (a: string) => /^(\S+) \(/.exec(a.trim())?.[1] ?? a;
  const replaced = new Set(labels.map(tierOf));
  const next: Meta = { ...m, attempts: [...m.attempts.filter((a) => !replaced.has(tierOf(a))), ...labels] };
  writeMeta(p, next);
  return next;
}

// --- drug labels --------------------------------------------------------------

// A DailyMed label is one entry per set ID, always the current version: the
// SPL XML and its Markdown as the full text, no abstract. The meta carries the
// label's version in `version` ("spl <n>"), the effective year in `year`, the
// labeler as first_author, "Drug Label" as the publication type, and
// pubmed_checked as the date the current version was last confirmed.
export function writeLabelEntry(p: EntryPaths, s: SplDoc, xml: string, converter: string): Meta {
  mkdirSync(p.entryDir, { recursive: true });
  const raw = p.fulltextRaw("xml");
  writeAtomic(raw, xml);
  writeAtomic(p.fulltextMd, renderLabelMd(s));
  const meta: Meta = {
    pmid: "", setid: s.setid, nctid: null, publications: [], pmcid: null, doi: null, title: s.title, first_author: s.labeler, year: s.effective?.slice(0, 4) ?? null,
    publication_types: ["Drug Label"], retracted: false, corrections: [], coi: null, funding: [],
    has_abstract: false, level: "full_text", version: s.version ? `spl ${s.version}` : null,
    files: [basename(raw), basename(p.fulltextMd)],
    retrieved_by: "dailymed", retrieved_date: today(), converted_by: converter, pubmed_checked: today(), attempts: [],
  };
  writeMeta(p, meta);
  return meta;
}

// --- trial records ------------------------------------------------------------

// A ClinicalTrials.gov record is one entry per NCT ID, always the current
// record: the API JSON and its Markdown as the full text, no abstract. The
// meta carries the last-update-posted date as `version`, the first-posted year
// as `year`, the lead sponsor as first_author, "Trial Registration" as the
// publication type, the results publications, and pubmed_checked as the date
// the current record was last confirmed.
export function writeStudyEntry(p: EntryPaths, s: StudyDoc, json: string, converter: string): Meta {
  mkdirSync(p.entryDir, { recursive: true });
  const raw = p.fulltextRaw("json");
  writeAtomic(raw, json);
  writeAtomic(p.fulltextMd, renderStudyMd(s));
  const meta: Meta = {
    pmid: "", setid: null, nctid: s.nctid, publications: s.publications, pmcid: null, doi: null, title: s.title, first_author: s.sponsor, year: s.firstPosted?.slice(0, 4) ?? null,
    publication_types: ["Trial Registration"], retracted: false, corrections: [], coi: null, funding: [],
    has_abstract: false, level: "full_text", version: s.lastUpdate,
    files: [basename(raw), basename(p.fulltextMd)],
    retrieved_by: "ctgov", retrieved_date: today(), converted_by: converter, pubmed_checked: today(), attempts: [],
  };
  writeMeta(p, meta);
  return meta;
}

// --- papers without a PMID ------------------------------------------------------

// A paper PubMed does not index: the Crossref record (JSON) stored as
// <entry>-crossref.json, the abstract Markdown as for a PubMed record, the
// meta with pmid "" — the full-text cascade then runs as for any paper.
// retrieved_by names the source of what the level holds: the abstract's
// source ("crossref" or "openalex"), or "crossref" for the title alone.
export function writeDoiEntry(p: EntryPaths, r: PubmedRecord, json: string, converter: string, abstractFrom = "crossref", recordFrom = "crossref"): Meta {
  mkdirSync(p.entryDir, { recursive: true });
  // The record as its source gave it: Crossref's JSON, or doi.org's CSL JSON for another registry.
  const raw = p.fulltextRaw("json").replace(/-fulltext\.json$/, recordFrom === "crossref" ? "-crossref.json" : "-csl.json");
  writeAtomic(raw, json);
  writeAtomic(p.md, renderAbstractMd(r));
  const meta = { ...metaFromRecord(r, [basename(raw), basename(p.md)], converter), retrieved_by: r.abstract.length ? abstractFrom : recordFrom };
  writeMeta(p, meta);
  return meta;
}
