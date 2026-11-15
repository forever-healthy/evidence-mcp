import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { applyFulltext, copyEntry, daysSince, emptyStatus, entryExists, readHeadLine, readMeta, readStatus, recordAttempts, refreshRecord, statusFromMeta, today, writeEntry, writeMeta, type Meta, type Status } from "./entry.js";
import { settings } from "./config.js";
import { attemptLabel, fulltextCascade } from "./cascade.js";
import type { EntryPaths } from "./layout.js";
import { parseId } from "./ids.js";
import { entryPaths, FH_EVIDENCE_DIR } from "./layout.js";
import { fetchPubmedXml, isRetractionNotice, parsePubmedXml, type Correction } from "./pubmed.js";
import { libraryInfo } from "./info.js";
import { assembleDeclarations, findSections, outline, readSection, search, type SearchResult } from "./read.js";
import { HOST, LOG_FILE, log } from "./log.js";
import { verifyConfig } from "./verify/config.js";
import { unlockerHealth } from "./unlock.js";
import { probe } from "./hosts.js";
import { decider } from "./verify/decider.js";
import { fetchSpl, parseSpl } from "./spl.js";
import { fetchStudy, parseStudy } from "./ctgov.js";
import { fetchCrossref, fetchCsl, openAlexAbstract, parseCrossref, parseCsl, pmidForDoi } from "./doi.js";
import { writeDoiEntry, writeLabelEntry, writeStudyEntry } from "./entry.js";
import { fetchAnswer, libraryFetch, libraryIdForUrl, logId } from "./urlfetch.js";
import { verifyCached } from "./verify/cache.js";
import { bump, currentStats } from "./stats.js";
import { compact, leanJson, readAnswer, searchAnswer, statusAnswer, verdictAnswer } from "./json.js";
import { MAX_RESULTS as MAX_TRIALS, searchCacheDays, searchTrials, trialsLogId } from "./trials.js";
import { logId as pubmedLogId, MAX_RESULTS as MAX_PAPERS, searchArticles } from "./pubmedsearch.js";
import { recordSummary, resultsText } from "./trialrecord.js";
import { fetchArticles, MAX_PMIDS } from "./pubmedbatch.js";
import { freshMissing, missingNote, rememberMissing } from "./missing.js";

// Read our own name/version from the package.json shipped alongside dist/,
// so the reported version always matches what was actually published rather
// than a hardcoded string that drifts.
export const pkg: { name: string; version: string } = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  } catch {
    return { name: "evidence-mcp", version: "0.0.0" };
  }
})();

// Server-level instructions surfaced to the connecting agent/model at
// initialize (the MCP `instructions` field). This is the one place to explain,
// up front, what the library is and how the tools fit together — so an agent
// can use it without having to infer everything from tool names.
export const INSTRUCTIONS = `evidence-mcp keeps a local library of scientific papers, FDA drug labels, clinical trial records and web pages, so you can check what a source actually says, and searches ClinicalTrials.gov. The server downloads each record, converts it to Markdown and stores it on disk. Every tool returns a small JSON answer; the document itself never enters your context — except fh_fetch_url, which is the standard fetch tool with a cache. One ID per call.

IDs — always "type:value"
- pmid:30955454 — a paper by PubMed ID. Bare digits are taken as a PMID.
- doi:10.… — a paper by DOI. A DOI PubMed indexes is stored under its PMID; any other gets its record from Crossref.
- dailymed:<set ID> — an FDA prescribing-information label, current version. The set ID is the "setid=" value in the label's DailyMed URL.
- nct:05173896 — a ClinicalTrials.gov trial record, current version. NCT05173896 is accepted too.

Tools
- fh_info() — this server's package and version, then the whole library: entry counts by type and level, the retrieval sources, browsers, the decision model, the configuration, this server's cache hits and misses since it started (cache).
- fh_library_add(id) — download and store one record; returns its status. A stored full text is returned without any download; an abstract-level record retries only the sources that failed transiently; a record older than 30 days gets its correction notices re-read.
- fh_library_status(id) — the status of one record without downloading; level "missing" when it is not stored.
- fh_library_read(id, section?, query?, max_chars?, max_hits?) — one small piece of a stored document: its outline, one section, or the passages matching a query.
- fh_verify_claim(claim, id) — does this one source state this one finding? A decision model judges the stored text and returns a verdict.
- fh_pubmed_fetch_articles(pmids) — title, first author, year, publication types, retracted and level for up to 200 PMIDs at once; faster and far smaller than asking PubMed, known papers from disk, the rest in one request and stored. For abstract or full text: fh_library_read.
- fh_pubmed_search_articles(query, max_results?, sort?, years?) — search PubMed in its own syntax: the total and rows in columns order (PMID, title, first author, year, journal, publication types, PMCID, library level); faster and far smaller than asking PubMed. Cached a week.
- fh_clinicaltrials_search_studies(query | intervention | condition, status?, sort?, max_results?) — search ClinicalTrials.gov: the total and rows in columns order (NCT ID, title, status, phase, enrollment, dates, primary outcome, conditions, interventions, has_results). Cached a week.
- fh_clinicaltrials_get_study_record(nct) — one trial as a review needs it (status, design, enrollment, dates, outcomes, eligibility, result publications, summary), from the stored record; added first when missing.
- fh_clinicaltrials_get_study_results(nct, max_chars?) — a trial's posted results as Markdown, capped; the outcome titles listed for fh_library_read.
- fh_fetch_url(url, max_length?, start_index?, raw?, title_only?) — a web page as Markdown, same call and same answer as the standard fetch tool ("Contents of <url>:" and the page, cut at max_length with a note on how to continue). Prefer it for every URL: a cached page answers from disk, a walled or script-rendered page runs through the browser and unlocker stages in one call. PDFs as Markdown; XML, JSON and other text as is. title_only returns the title line alone — enough to verify a link, at a few tokens.

Hints
- fh_library_read and fh_verify_claim store a missing record themselves; the fh_library_read answer then carries added: true. No fh_library_add necessary first.
- citable false — the paper is retracted (a retraction notice, or PubMed's publication type), or holds nothing to read: no abstract and no full text. comment says which; corrections lists the notices as {type, pmid, source}.
- level — what is stored: "full_text", "abstract" (no full text could be found; the log names each source tried and why it failed) or "title" (not even an abstract; citable false).
- error "pmid not found", "doi not found", "ctgov: not a study record", "dailymed: not an SPL document" — no service knows the ID. Remembered for a day (FH_RETRY_AFTER_DAYS): the same call answers from disk with the date it was checked; after that the service is asked again. "invalid id" — the ID itself is malformed; the same call gives the same answer. A URL is no library ID: it is refused with what to send instead — the record's ID for a PubMed, doi.org, ClinicalTrials.gov or DailyMed URL, else fh_fetch_url for the web page.
- Calls may run in parallel: fh_library_add, fh_library_read and fh_verify_claim. Two calls on the same missing record share one add.
- fh_fetch_url takes any URL that is not a paper, label or trial record; those have IDs, and fh_library_add, fh_library_read and fh_verify_claim work on the stored document. A second pass over the same review reads every page from disk; a failed fetch is remembered for a day.
- To verify that a web page exists and what it is: fh_fetch_url(url, title_only: true). The answer is "Contents of <url>:" and the page's title line — a few tokens — or the fetch error; the page itself is stored in full, so a later fh_fetch_url of the same URL reads from disk.

Verifying a claim
- fh_verify_claim judges one claim against one stored document. A finding backed by three papers takes three calls with the same claim.
- It expects the finding as a complete sentence: who or what, the intervention, the outcome, the number. Citation markers and commentary around the finding are not part of what a document states.
- It can only confirm what this one document states. A finding about two interventions from two papers is two claims, each against its own paper. A summary of several trials ("trials used 60–200 mg") is stated by none of them; the dose this one trial used is.
- It returns error for a claim under four words, a sentence fragment, or a claim still containing citations. A short finding with its setting (in vitro, cell line, dose) is accepted; filler words do not help.
- verdict "pass" — the document states the claim. score is the model's probability.
- verdict "fail" — the stored full text does not state the claim as worded; fh_library_read with a query shows what the document does say. Or, with basis "title", nothing is stored to read: reason says so, score is null.
- verdict "unverifiable" — only the abstract is stored and it does not state the claim; the full text may (reason says so). A retry gives the same answer until a full text is stored.
- glyphs_unresolved above 0 — the PDF font lost symbols (minus, ±, ≤); a fail on a number may be the font. fh_library_read shows the passage.
- superseded true — a published correction replaced the figure the claim uses; the status's corrections holds the notice.
- Verdicts are kept for 30 days: the same claim against the same stored text answers from disk, no model call. A paper that gains its full text is judged afresh.

Reading a document
- fh_library_read with only the ID returns the outline: every heading with its word count, and whether the full text or only the abstract is stored.
- section — a heading from the outline, matched case-insensitively as a substring; the text is capped at max_chars (default 6000). A heading that occurs several times is listed as "Participants [3/12]" and is addressed that way.
- query — returns the passages holding every term: up to max_hits (default 5), each at most 1000 characters around the matches, with its section, best first. It works best with two or three distinctive terms the document itself would use (a measure and a unit, an outcome and a group, a compound name), not a claim sentence. Case, accents, hyphens, plurals and -ed/-ing forms are matched.
- partial true — no passage holds every term; missing_terms are the words the document never uses. The same query without them finds the passage if there is one.
- Numbers are often in tables; a matching table row comes with its header row.
- section and query together search inside that section only.
- section "Abstract" on a full text without one returns the stored abstract. section "Declarations" returns funding, conflicts of interest, acknowledgements and ethics statements, assembled when the document has no section of that name, else the statements of the PubMed or Crossref record.

Status fields: pmid, pmcid, setid, nctid, publications, year, publication_types, retracted, corrections, citable, comment, has_abstract, level, version, retrieved_by, glyphs_unresolved, error. Funding and conflicts of interest: fh_library_read section "Declarations". Answers carry only what the call did not send: no echo of the ID, claim or query; a field that is null or an empty list is left out. fh_verify_claim always has verdict, score (null: no judgement) and basis.

Where records come from: PubMed for the record and abstract; the full text from PubMed Central, Europe PMC, publishers' text-mining links, Unpaywall, OpenAlex, CORE, and a proxy URL template from the configuration. Every action is appended as one line to <library>/logs/evidence.log.`;

const idSchema = z.string().describe('ID as "type:value": a paper "pmid:30955454" (bare digits count as pmid) or "doi:10.5812/asjsm.110753" (a paper PubMed does not index; a DOI PubMed indexes is taken as its PMID), a drug label "dailymed:<set ID>" (the set ID from its DailyMed page URL), or a trial record "nct:05173896" (the eight digits; nct:NCT05173896 and a bare NCT05173896 are accepted).');

// The level as a log line writes it: "title" for an entry without full text
// and without abstract text — "abstract retrieved_by=crossref" would read as
// an abstract that came from Crossref. The status says "title" too
// (statusFromMeta); the meta file keeps level "abstract" and has_abstract no.
const levelWord = (m: Meta) => (m.level === "abstract" && !m.has_abstract ? "title" : m.level);

// Status answers: compact and lean — no nulls, no empty lists, no paths (src/json.ts, #32).
const json = (s: Status) => ({ content: [{ type: "text" as const, text: statusAnswer(s as unknown as Record<string, unknown>) }] });

// The notices of an entry for the log line: " retracted erratum=1 concern=1
// update=1" — only what is there, empty when nothing is.
export function noticeTag(m: Meta): string {
  const n = (t: Correction["type"]) => m.corrections.filter((c) => c.type === t).length;
  const parts = [
    m.retracted ? "retracted" : "",
    n("erratum_in") ? `erratum=${n("erratum_in")}` : "",
    n("expression_of_concern_in") ? `concern=${n("expression_of_concern_in")}` : "",
    n("update_in") ? `update=${n("update_in")}` : "",
  ].filter(Boolean);
  return parts.length ? " " + parts.join(" ") : "";
}

// Register every tool on an already-constructed server. The stdio entry
// (src/index.ts) builds the McpServer and calls this, so the tool set lives in
// one place regardless of how the server is started.
// A verify error that is the model's, not the claim's: no model configured, or
// the request to it failed (HTTP error, timeout, no answer) — logged as "!!".
const modelFailure = (error: string, cfg: { model: string } | null) => error.startsWith("no verify model configured") || (!!cfg && error.startsWith(`${cfg.model}:`));

export function registerTools(server: McpServer): void {
  // IDs are "type:value" (pmid:30955454, doi:10.…, pmc:PMC…, nct:NCT…); bare
  // digits count as pmid. One ID per call — no batches (the GitHub issues for what is not).

  // fh_library_add(id) — build or complete the entry through the retrieval
  // cascade; returns its status. Idempotent: an existing entry is returned as
  // is (v0.1 never upgrades an entry; full-text retries come with the tiers).
  // Runs the full-text cascade on an abstract-level entry and writes the
  // result: files + upgraded meta on a hit, new attempts on misses.
  async function completeFulltext(paths: EntryPaths, meta: Meta, requested: string): Promise<{ meta: Meta; ran: boolean }> {
    const paper = { title: meta.title, pmid: meta.pmid, pmcid: meta.pmcid, doi: meta.doi, headLine: readHeadLine(paths) };
    // A tier whose attempts were logged line by line closes with a bare
    // "failed" — the reasons are the lines above; its attempts entry keeps them.
    const tried = new Set<string>();
    let ran = false;   // any tier considered at all — false when every tier is in cooldown or permanently failed
    const { hit } = await fulltextCascade(paper, meta.attempts, (e) => {
      // "!! …": a service refused the deployment, not the paper.
      if (e.ok === "alert") { log("add", requested, `!! ${e.message}`); return; }
      if (e.ok === "try") tried.add(e.tier);
      if (e.ok === false && e.ephemeral) return;
      ran = true;
      // Written as it happens, not at the end: a server killed mid-cascade
      // keeps what it learned, and the next call does not redo those tiers.
      if (e.ok === false) meta = recordAttempts(paths, meta, [attemptLabel(e)]);
      log("add", requested,
        e.ok === true ? `tier ${e.tier} ok (${e.format}, ${e.version})`
        : e.ok === "try" ? `tier ${e.tier} ${e.message}`
        : e.skipped ? `tier ${e.tier} skipped: ${e.reason}`
        : tried.has(e.tier) ? `tier ${e.tier} failed`
        : `tier ${e.tier} failed: ${e.reason}`);
    });
    if (hit) meta = applyFulltext(paths, meta, hit, `${pkg.name} ${pkg.version}`);
    return { meta, ran };
  }

  // A drug label: fetched from DailyMed by set ID, always the current version.
  // An existing entry older than refresh_after_days is re-fetched and
  // rewritten when the label's version changed.
  async function addLabel(requested: string, setid: string, paths: EntryPaths, status: Status): Promise<Status> {
    if (entryExists(paths)) {
      const meta = readMeta(paths);
      if (daysSince(meta.pubmed_checked) < settings().refresh_after_days) { log("add", requested, `exists level=full_text retrieved_by=dailymed ${meta.version ?? ""} ${meta.year ?? ""}`); return statusFromMeta(paths, meta, status); }
      try {
        const xml = await fetchSpl(setid); const s = parseSpl(xml);
        if (!s) throw new Error("dailymed: not an SPL document");
        const version = s.version ? `spl ${s.version}` : null;
        if (version === meta.version) { const next = { ...meta, pubmed_checked: today() }; writeMeta(paths, next); log("add", requested, `exists level=full_text retrieved_by=dailymed ${meta.version ?? ""} checked`); return statusFromMeta(paths, next, status); }
        const next = writeLabelEntry(paths, s, xml, `${pkg.name} ${pkg.version}`);
        log("add", requested, `refreshed level=full_text retrieved_by=dailymed ${meta.version ?? "?"} → ${next.version} effective=${s.effective}`);
        return statusFromMeta(paths, next, status);
      } catch (e) { log("add", requested, `refresh failed: ${e instanceof Error ? e.message : String(e)}`); return statusFromMeta(paths, meta, status); }
    }
    try {
      const xml = await fetchSpl(setid); const s = parseSpl(xml);
      if (!s) { rememberMissing(paths, "dailymed: not an SPL document"); log("add", requested, "dailymed failed: not an SPL document (remembered)"); return { ...status, error: "dailymed: not an SPL document" }; }
      const meta = writeLabelEntry(paths, s, xml, `${pkg.name} ${pkg.version}`);
      log("add", requested, `dailymed fetched level=full_text ${meta.version ?? ""} effective=${s.effective} ${s.brand ?? ""} (${s.generic ?? ""}) entry=${paths.entry}`);
      return statusFromMeta(paths, meta, status);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const gone = /not an SPL document|^HTTP 404\b/.test(msg);   // no such label: remembered; a transient failure is not
      if (gone) rememberMissing(paths, msg.startsWith("HTTP 404") ? "dailymed: no label for this set ID (HTTP 404)" : msg);
      log("add", requested, `dailymed failed: ${msg}${gone ? " (remembered)" : ""}`); return { ...status, error: msg };
    }
  }

  // A trial record: fetched from ClinicalTrials.gov by NCT ID, always the
  // current record; re-fetched after refresh_after_days and rewritten when
  // its last-update-posted date moved.
  async function addStudy(requested: string, nctid: string, paths: EntryPaths, status: Status): Promise<Status> {
    if (entryExists(paths)) {
      const meta = readMeta(paths);
      if (daysSince(meta.pubmed_checked) < settings().refresh_after_days) { log("add", requested, `exists level=full_text retrieved_by=ctgov updated ${meta.version ?? ""}`); return statusFromMeta(paths, meta, status); }
      try {
        const json = await fetchStudy(nctid); const s = parseStudy(json);
        if (!s) throw new Error("ctgov: not a study record");
        if (s.lastUpdate === meta.version) { const next = { ...meta, pubmed_checked: today() }; writeMeta(paths, next); log("add", requested, `exists level=full_text retrieved_by=ctgov updated ${meta.version ?? ""} checked`); return statusFromMeta(paths, next, status); }
        const next = writeStudyEntry(paths, s, json, `${pkg.name} ${pkg.version}`);
        log("add", requested, `refreshed level=full_text retrieved_by=ctgov updated ${meta.version ?? "?"} → ${next.version} ${s.status ?? ""}${s.hasResults ? " results" : ""}`);
        return statusFromMeta(paths, next, status);
      } catch (e) { log("add", requested, `refresh failed: ${e instanceof Error ? e.message : String(e)}`); return statusFromMeta(paths, meta, status); }
    }
    try {
      const json = await fetchStudy(nctid); const s = parseStudy(json);
      if (!s) { rememberMissing(paths, "ctgov: not a study record"); log("add", requested, "ctgov failed: not a study record (remembered)"); return { ...status, error: "ctgov: not a study record" }; }
      const meta = writeStudyEntry(paths, s, json, `${pkg.name} ${pkg.version}`);
      log("add", requested, `ctgov fetched level=full_text updated ${meta.version ?? ""} ${s.status ?? ""}${s.hasResults ? " results" : ""} ${s.acronym ?? ""} entry=${paths.entry}`);
      return statusFromMeta(paths, meta, status);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const gone = /not a study record|^HTTP 404\b/.test(msg);
      if (gone) rememberMissing(paths, msg.startsWith("HTTP 404") ? "ctgov: no study for this NCT ID (HTTP 404)" : msg);
      log("add", requested, `ctgov failed: ${msg}${gone ? " (remembered)" : ""}`); return { ...status, error: msg };
    }
  }

  server.tool(
    "fh_library_add",
    "Download and store one record — a paper (pmid:, doi:), a drug label (dailymed:<set ID>) or a trial record (nct:<8 digits>) — and return its status JSON. A paper gets its record, abstract and correction notices from PubMed (Crossref for a DOI PubMed does not index), then the full text from the configured sources; a label or trial record is stored as a full text. A stored full text is returned without any download; an abstract-level record retries only sources that failed transiently; a record older than 30 days gets its notices re-read.",
    { id: idSchema },
    ({ id }) => addEntry(id)
  );

  // One add in flight per ID: two parallel reads of a paper not yet in the
  // library (reads may run in parallel) share one cascade instead of racing.
  const inflight = new Map<string, Promise<ReturnType<typeof json>>>();
  function addEntry(id: string): Promise<ReturnType<typeof json>> {
    const key = parseId(id).requested;
    let p = inflight.get(key);
    if (!p) { p = addEntryNow(id).finally(() => inflight.delete(key)); inflight.set(key, p); }
    return p;
  }

  async function addEntryNow(id: string) {
      const t0 = Date.now();   // the whole add, for the "done" line
      let parsed = parseId(id);
      // An ID no service knew within the last retry_after_days: answered from its marker, no request (src/missing.ts).
      if (!parsed.error) {
        const mp = entryPaths(FH_EVIDENCE_DIR, parsed.type!, parsed.id!);
        const miss = entryExists(mp) ? null : freshMissing(mp, settings().retry_after_days);
        if (miss) { log("add", parsed.requested, `missing cached: ${miss.reason} (${miss.checked})`); return json({ ...emptyStatus(parsed.requested, parsed.type, parsed.id, FH_EVIDENCE_DIR), entry: mp.entry, level: "missing", error: missingNote(miss, settings().retry_after_days) }); }
      }
      if (parsed.error) { log("add", parsed.requested, `error ${parsed.error}`); return json({ ...emptyStatus(parsed.requested, parsed.type, parsed.id, FH_EVIDENCE_DIR), error: parsed.error }); }
      // A DOI PubMed indexes is stored twice: as its pmid: entry, and as a
      // copy under doi:, so the DOI resolves on disk — fh_library_status, fh_library_read and fh_verify_claim
      // never look it up. A doi: entry carrying a pmid is such a copy: its
      // pmid: entry is completed, then copied again. PubMed is asked only for
      // a DOI not yet in the library.
      let copyTo: EntryPaths | null = null;
      if (parsed.type === "doi") {
        const doiPaths = entryPaths(FH_EVIDENCE_DIR, "doi", parsed.id!);
        let pmid: string | null = entryExists(doiPaths) ? readMeta(doiPaths).pmid || null : null;
        if (!pmid && !entryExists(doiPaths)) {
          try { pmid = await pmidForDoi(parsed.id!); } catch (e) { log("add", parsed.requested, `pubmed lookup failed: ${e instanceof Error ? e.message : String(e)}`); }
          // Only a PMID whose record the library can read: a DOI never ends worse than without the mapping.
          if (pmid && !entryExists(entryPaths(FH_EVIDENCE_DIR, "pmid", pmid))) {
            try { if (!parsePubmedXml(await fetchPubmedXml(pmid))) { log("add", parsed.requested, `pmid:${pmid} has no readable PubMed record — kept as doi:`); pmid = null; } } catch { /* the pmid path reports it */ }
          }
          if (pmid) log("add", parsed.requested, `indexed in PubMed as pmid:${pmid}`);
        }
        if (pmid) { copyTo = doiPaths; parsed = { requested: parsed.requested, type: "pmid", id: pmid }; }
      }
      const status = emptyStatus(parsed.requested, parsed.type, parsed.id, FH_EVIDENCE_DIR);
      const isDoi = parsed.type === "doi";

      const paths = entryPaths(FH_EVIDENCE_DIR, parsed.type!, parsed.id!);
      // The status of the entry the caller named: the doi: copy for a DOI.
      const finish = (m: Meta) => {
        if (!copyTo) return json(statusFromMeta(paths, m, status));
        const copy = copyEntry(paths, copyTo);
        return json(statusFromMeta(copyTo, copy, emptyStatus(parsed.requested, "doi", parseId(parsed.requested).id, FH_EVIDENCE_DIR)));
      };
      if (parsed.type === "dailymed") return json(await addLabel(`dailymed:${parsed.id}`, parsed.id!, paths, status));
      if (parsed.type === "nct") return json(await addStudy(`nct:${parsed.id}`, `NCT${parsed.id}`, paths, status));
      let meta: Meta, ran = false;
      const entryExistedBefore = entryExists(paths);
      if (entryExistedBefore) {
        meta = readMeta(paths);
        // Notices appear after ingest: an old record is re-read (never the
        // abstract or full text). A failed re-read keeps the entry as it is.
        if (isDoi && daysSince(meta.pubmed_checked) >= settings().refresh_after_days) {
          // Crossref's update notices (corrections, retractions) appear after ingest too.
          try {
            const r = parseCrossref((await fetchCrossref(parsed.id!)) ?? "");
            if (r) {
              const before = noticeTag(meta);
              meta = { ...meta, corrections: r.corrections, retracted: r.corrections.some(isRetractionNotice), funding: meta.funding.length ? meta.funding : r.funding, pubmed_checked: today() };
              writeMeta(paths, meta);
              log("add", parsed.requested, `refreshed crossref${noticeTag(meta) !== before ? ` changed: ${before.trim() || "none"} → ${noticeTag(meta).trim() || "none"}` : ""}`);
            } else log("add", parsed.requested, "refresh failed: doi not found");
          } catch (e) { log("add", parsed.requested, `refresh failed: ${e instanceof Error ? e.message : String(e)}`); }
        } else if (daysSince(meta.pubmed_checked) >= settings().refresh_after_days) {
          try {
            const xml = await fetchPubmedXml(parsed.id!);
            const record = parsePubmedXml(xml);
            if (record) {
              const before = noticeTag(meta);
              meta = refreshRecord(paths, meta, record, xml);
              log("add", parsed.requested, `refreshed pubmed_checked=${meta.pubmed_checked}${noticeTag(meta) !== before ? ` changed: ${before.trim() || "none"} → ${noticeTag(meta).trim() || "none"}` : ""}`);
            } else log("add", parsed.requested, "refresh failed: pmid not found");
          } catch (e) {
            log("add", parsed.requested, `refresh failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (meta.level === "full_text") {
          log("add", parsed.requested, `exists level=full_text retrieved_by=${meta.retrieved_by}${noticeTag(meta)} ${meta.doi ? `doi:${meta.doi}` : "no-doi"}`);
          return finish(meta);
        }
        log("add", parsed.requested, `exists level=${levelWord(meta)}${noticeTag(meta)} ${meta.doi ? `doi:${meta.doi}` : "no-doi"}`);
      } else if (isDoi) {
        let json_: string | null;
        try { json_ = await fetchCrossref(parsed.id!); } catch (e) { const msg = e instanceof Error ? e.message : String(e); log("add", parsed.requested, `crossref failed: ${msg}`); return json({ ...status, error: msg }); }
        let record = json_ ? parseCrossref(json_) : null;
        // Another registry (DataCite, mEDRA, …): doi.org's CSL JSON.
        let recordFrom = "crossref";
        if (!record) { const csl = await fetchCsl(parsed.id!); record = csl ? parseCsl(csl) : null; if (record) { json_ = csl; recordFrom = "doi.org"; } }
        if (!record) { rememberMissing(paths, "doi not found"); log("add", parsed.requested, "crossref failed: doi not found at Crossref or doi.org (remembered)"); return json({ ...status, error: "doi not found" }); }
        if (!record.doi) record.doi = parsed.id!;
        let abstractFrom = recordFrom;
        if (!record.abstract.length) { const t = await openAlexAbstract(parsed.id!); if (t) { record.abstract = [{ label: null, text: t }]; abstractFrom = "openalex"; } }
        meta = writeDoiEntry(paths, record, json_!, `${pkg.name} ${pkg.version}`, abstractFrom, recordFrom);
        log("add", parsed.requested, `${recordFrom === "crossref" ? "crossref" : "doi.org"} fetched level=${levelWord(meta)} — not in PubMed${noticeTag(meta)}${meta.has_abstract ? ` abstract from ${abstractFrom}` : ""} entry=${paths.entry}`);
      } else {
        let xml: string;
        try {
          xml = await fetchPubmedXml(parsed.id!);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log("add", parsed.requested, `pubmed failed: ${msg}`);
          return json({ ...status, error: msg });
        }
        const record = parsePubmedXml(xml);
        if (!record) { rememberMissing(paths, "pmid not found"); log("add", parsed.requested, "pubmed failed: pmid not found (remembered)"); return json({ ...status, error: "pmid not found" }); }
        meta = writeEntry(paths, record, xml, `${pkg.name} ${pkg.version}`);
        log("add", parsed.requested, `pubmed fetched level=${levelWord(meta)}${noticeTag(meta)} ${meta.doi ? `doi:${meta.doi}` : "no-doi"}${meta.pmcid ? ` pmcid:${meta.pmcid}` : ""} entry=${paths.entry}`);
      }

      // An existing abstract entry with nothing to retry ends with its "exists"
      // line, like a full_text entry; "done" closes a cascade that ran.
      ({ meta, ran } = await completeFulltext(paths, meta, parsed.requested));
      if (entryExistedBefore && !ran) return finish(meta);
      const secs = `${((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0")}s`;   // "08.3s", like the verify lines
      log("add", parsed.requested, `done ${secs} level=${levelWord(meta)} retrieved_by=${meta.retrieved_by}`);
      return finish(meta);
  }

  // fh_library_status(id) — read-only: presence and level.
  server.tool(
    "fh_library_status",
    "Read-only status of the library entry for one ID — a paper, a drug label or a trial record: the same status JSON as fh_library_add, or level \"missing\" when there is no entry. Never fetches.",
    { id: idSchema },
    async ({ id }) => {
      const parsed = parseId(id);
      const status = emptyStatus(parsed.requested, parsed.type, parsed.id, FH_EVIDENCE_DIR);
      if (parsed.error) { log("status", parsed.requested, `error ${parsed.error}`); return json({ ...status, error: parsed.error }); }

      const paths = entryPaths(FH_EVIDENCE_DIR, parsed.type!, parsed.id!);
      if (entryExists(paths)) { const s = readStatus(paths, status); log("status", parsed.requested, `level=${s.level}`); return json(s); }
      const miss = freshMissing(paths, settings().retry_after_days);
      log("status", parsed.requested, miss ? `level=missing (${miss.reason}, ${miss.checked})` : "level=missing");
      return json({ ...status, entry: paths.entry, level: "missing", ...(miss ? { error: missingNote(miss, settings().retry_after_days) } : {}) });
    }
  );

  // fh_library_read(id, section | query) — one passage of an entry's Markdown,
  // not the whole paper: the deliberate, small flow through context for claim
  // verification. Outline first, then a section by heading or passages by query.
  server.tool(
    "fh_library_read",
    "One piece of a stored document's Markdown, never the whole. No section/query: the outline (headings with word counts; full text or abstract only). section: that heading's own text (case-insensitive substring; a repeated heading as \"Participants [3/12]\"), capped at max_chars, its subsections listed. query: passages holding every term, each a window of at most 1000 chars with its section, best first, at most max_hits (more: how many further passages match); partial: true with missing_terms when no passage holds them all. section and query together: inside that section. A missing paper is added first (added: true).",
    {
      id: idSchema,
      section: z.string().optional().describe("Heading from the outline (case-insensitive substring)."),
      query: z.string().optional().describe("Two or three distinctive terms the paper itself would use — a measure and a unit, an outcome and a group, a compound name — not the claim. Passages holding all of them are returned, else the best partial matches. With section: inside that section."),
      max_chars: z.number().int().positive().optional().describe("Cap for section text (default 6000); passages are capped at 1000 chars each regardless."),
      max_hits: z.number().int().positive().optional().describe("Cap for query passages (default 5)."),
    },
    async ({ id, section, query, max_chars, max_hits }) => {
      const parsed = parseId(id);
      const out = (o: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: readAnswer(o) }] });
      if (parsed.error) { log("read", parsed.requested, `error ${parsed.error}`); return out({ requested: parsed.requested, error: parsed.error }); }
      const paths = entryPaths(FH_EVIDENCE_DIR, parsed.type!, parsed.id!);
      // Not in the library yet: added first, as fh_library_add would (its lines
      // in the log), then read. A paper the add cannot build stays an error.
      let added = false;
      if (!entryExists(paths)) {
        log("read", parsed.requested, "missing adding first");
        const r = JSON.parse((await addEntry(id)).content[0].text) as { error?: string };
        if (!entryExists(paths)) { log("read", parsed.requested, `error ${r.error ?? "fh_library_add failed"}`); return out({ requested: parsed.requested, entry: paths.entry, error: `not in the library and fh_library_add failed: ${r.error ?? "unknown"}` }); }
        added = true;
      }
      const full = existsSync(paths.fulltextMd);
      const md = readFileSync(full ? paths.fulltextMd : paths.md, "utf8");
      const text = full ? "full_text" : "abstract";
      const base = added ? { requested: parsed.requested, entry: paths.entry, text, added: true } : { requested: parsed.requested, entry: paths.entry, text };
      const headings = () => outline(md, text).sections;
      const describe = (r: SearchResult) => `${r.passages.length} passages${r.partial ? " partial" : ""}${r.passages.filter((x) => x.clipped).length ? ` ${r.passages.filter((x) => x.clipped).length} clipped` : ""}${r.missing_terms.length ? ` (missing: ${r.missing_terms.join(", ")})` : ""}`;
      if (section && query) {
        const found = findSections(md, section);
        if (found.length !== 1) {
          log("read", parsed.requested, `section "${section}" query "${query}" → ${found.length ? `${found.length} sections match` : "section not found"}`);
          if (!found.length) return out({ ...base, error: `no section matching "${section}"`, outline: headings() });
          return out({ ...base, error: `${found.length} sections match "${section}" — name one, e.g. "${found[0].label}"`, ambiguous: found.map((s) => ({ heading: s.label, words: s.words })) });
        }
        const r = search(md, query, max_hits ?? 5, { scope: found[0] });
        log("read", parsed.requested, `section "${found[0].label}" query "${query}" → ${describe(r)}`);
        return out({ ...base, section: found[0].label, query, ...r });
      }
      if (section) {
        const cap = max_chars ?? 6000;
        let sec = readSection(md, section, cap);
        let via = "";
        if (!sec && /abstract/i.test(section) && full && existsSync(paths.md)) { sec = readSection(readFileSync(paths.md, "utf8"), "abstract", cap); via = " (from the abstract file)"; }
        if (!sec && /declaration/i.test(section)) { sec = assembleDeclarations(md, cap); via = " (assembled)"; }
        // No such sections in the text (an abstract, a bare PDF): the statements PubMed's or Crossref's record gave, kept in the meta.
        if (!sec && /declaration/i.test(section)) {
          const st = readStatus(paths, emptyStatus(parsed.requested, parsed.type, parsed.id, FH_EVIDENCE_DIR));
          const body = [st.coi ? `### Conflicts of interest\n\n${st.coi}` : "", st.funding?.length ? `### Funding\n\n${st.funding.map((f) => `- ${f}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
          if (body) { sec = { heading: "Declarations (from the record)", words: body.split(/\s+/).length, text: body, returned_words: body.split(/\s+/).length, truncated: false }; via = " (from the record)"; }
        }
        if (!sec) { log("read", parsed.requested, `section "${section}" not found`); return out({ ...base, error: `no section matching "${section}"`, outline: headings() }); }
        if ("ambiguous" in sec) {
          log("read", parsed.requested, `section "${section}" → ${sec.ambiguous.length} sections match`);
          return out({ ...base, error: `${sec.ambiguous.length} sections match "${section}" — name one, e.g. "${sec.ambiguous[0].heading}"`, ...sec });
        }
        log("read", parsed.requested, `section "${section}" → "${sec.heading}" ${sec.words} words${sec.truncated ? ` truncated to ${sec.returned_words}` : ""}${sec.subsections ? ` ${sec.subsections.length} subsections` : ""}${via}`);
        return out({ ...base, ...sec });
      }
      if (query) {
        const r = search(md, query, max_hits ?? 5);
        log("read", parsed.requested, `query "${query}" → ${describe(r)}`);
        // No hit: say what is there, so the caller can pick a section instead of guessing another term.
        if (!r.passages.length) return out({ ...base, query, ...r, sections: headings().map((s) => s.heading) });
        return out({ ...base, query, ...r });
      }
      const o = outline(md, text);
      log("read", parsed.requested, `outline ${o.sections.length} sections ${o.words} words`);
      return out({ ...base, ...o });
    }
  );

  // fh_verify_claim(claim, id) — one finding of the review against one paper
  // it cites, judged by the decision model FH_VERIFY_* names (src/verify/verify.ts design notes for the decisions).
  // One claim, one paper per call: the audit gets one row per source, and a
  // fixer can drop the one source that does not carry the finding.
  server.tool(
    "fh_verify_claim",
    "Does one source state one finding of a review? claim: the finding as a complete statement (subject, intervention, outcome, number), without citations or the review's framing, and only what this source reports. id: one source the review cites for it — paper, drug label (dailymed:…) or trial record (nct:…); added first when missing. The server reads the stored text and asks a decision model; nothing enters your context. verdict: pass (score is the probability) | fail (the full text does not state it; or only the title is stored — reason says so) | unverifiable (only the abstract is stored and does not state it — reason says so) | error (claim refused: under four words, a fragment, carrying citations; add failed; no model; model failure). basis: full_text | abstract | title. glyphs_unresolved: symbols the PDF font lost; above 0 a failed number may be the font. superseded: true when a stored correction replaced the claim's figure.",
    {
      claim: z.string().describe("One finding as a complete statement (subject, intervention, outcome, number), built from the review's words, without its citations and framing."),
      id: idSchema,
    },
    async ({ claim, id }) => {
      const t0 = Date.now();
      const cfg = verifyConfig();
      // Not in the library yet: added first (fh_library_add's lines in the log); the fh_library_add's own failure is verify's error then.
      const pid = parseId(id);
      if (!pid.error && !entryExists(entryPaths(FH_EVIDENCE_DIR, pid.type!, pid.id!))) { log("verify", pid.requested, "missing adding first"); await addEntry(id); }
      // The cache in front of the model (src/verify/cache.ts): the same claim on the same stored text answers from disk.
      const { cached, ...r } = await verifyCached(claim, id, cfg, cfg ? decider(cfg) : null, FH_EVIDENCE_DIR);
      if (!r.error && r.score !== null) bump("verify", cached);   // a judgement: from disk, or the model
      // Time first, padded so the columns line up ("  2.1s", " 13.1s"), then
      // the verdict, the basis, the score, "cached" when no model ran, and the whole claim (the provider is in fh_info and the TUI's decider line).
      const secs = `${((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0")}s`;   // "00.7s", "13.7s": two digits before the dot, one space after the ID
      // An error is no verdict: "error <why>", not "verdict=error" — the model's service down, or a claim refused (2026-11-11).
      log("verify", r.id, r.error ? `${modelFailure(r.error, cfg) ? "!! " : ""}${secs} ${"error".padEnd(20)} ${r.error} | ${claim}` : `${secs} verdict=${r.verdict.padEnd(12)} basis=${r.basis!.padEnd(9)} score=${r.score === null ? "-    " : r.score.toFixed(3)}${r.windows > 1 ? ` windows=${r.windows}` : ""}${cached ? " cached" : ""}${r.superseded ? " superseded" : ""}${r.glyphs_unresolved ? ` glyphs=${r.glyphs_unresolved}` : ""} | ${claim}`);
      return { content: [{ type: "text" as const, text: verdictAnswer(r) }] };
    }
  );

  // fh_info() — the server and the whole library in one JSON: package,
  // version and log first (which build is loaded), then counts by type and
  // level, retracted count.
  server.tool(
    "fh_info",
    "The server and the whole library as JSON: this server's package name and version (which build is loaded), its log file; evidence directory (evidence_dir) and host; entry count and size on disk; per type (pmid, doi, dailymed, nct) the entries by level (full_text, abstract, title) and retractions; counts of retracted and not-citable entries and of errata, expressions of concern and updates; the retrieval sources in run order and which are off (tiers); the multi-stage download (download): the Playwright servers with the version they must run, the Chrome stages, whether an unlocker is configured; the configuration and where each value came from — environment, .env or default, never the value (config); the decision model behind fh_verify_claim and whether it answers right now (verify); the unlockers and whether each answers right now (unlockers); our own stage hosts — fetch proxy, Playwright servers, Chrome — and whether each is reachable right now (stages); this server's cache hits and misses for fh_verify_claim and fh_fetch_url since it started (cache).",
    {},
    async () => {
      const info = libraryInfo(FH_EVIDENCE_DIR, HOST);
      // Is the decision model answering? One tiny request: a one-line state, one yes/no question.
      const cfg = verifyConfig();
      // Each unlocker the same way, alongside (one request to example.com each).
      const unlockerChecks = Promise.all(info.unlockers.map((u) => unlockerHealth(u.provider)));
      // Our own stage hosts: one TCP connect each (src/hosts.ts), free.
      const stageChecks = Promise.all(info.stages.map((s) => probe(s.host, s.port)));
      if (info.verify && cfg) {
        const t0 = Date.now();
        try {
          const a = await decider(cfg)("The sky is blue.", { q: { type: "noul", instructions: "Is the sky blue?" } });
          info.verify = { ...info.verify, ok: typeof a.q?.noul === "number", ms: Date.now() - t0, error: null };
        } catch (e) {
          info.verify = { ...info.verify, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
        }
      }
      info.unlockers = (await unlockerChecks).map((h, i) => ({ ...info.unlockers[i], ...h }));
      info.stages = (await stageChecks).map((h, i) => ({ ...info.stages[i], up: h.up, ms: h.ms, error: h.error }));
      log("info", null, `entries=${info.entries}${info.verify ? ` verify ${info.verify.model} ${info.verify.ok ? `ok ${info.verify.ms} ms` : `down: ${info.verify.error}`}` : " verify not configured"}${info.unlockers.map((u) => ` unlocker ${u.provider} ${u.ok ? `ok ${u.ms} ms` : `down: ${u.error}`}`).join("")}${info.stages.map((s) => ` stage ${s.name} ${s.up ? `up ${s.ms} ms` : `down: ${s.error}`}`).join("")}`);
      // This process's cache counters since it started (every server publishes them under <library>/.servers/ as well).
      const s = currentStats();
      const cache = s ? { since: s.started, verify: s.verify, fetch: s.fetch, search: s.search, pubmed: s.pubmed } : null;
      return { content: [{ type: "text" as const, text: compact({ package: pkg.name, version: pkg.version, log: LOG_FILE, ...info, cache }) }] };
    }
  );

  // fh_fetch_url(url, max_length?, start_index?, raw?) — the standard fetch
  // tool, cached: the answer is the reference fetch server's, the page comes
  // from disk when young enough, else through the multi-stage download (src/urlfetch.ts).
  server.tool(
    "fh_fetch_url",
    `Fetch a web page as Markdown: the standard fetch tool, cached and hardened. Use it for any URL instead of a plain fetch or a browser. A page fetched in the last ${settings().refresh_after_days} days is answered from disk in milliseconds; a page a plain fetch cannot get (403, rate limit, bot wall, script-rendered) is fetched through the configured browsers and unlockers in this one call. PDFs come back as Markdown; XML, JSON and other text as is. To verify a link, title_only returns just its title line. A PubMed, ClinicalTrials.gov, DailyMed or doi.org URL is answered from the library's record of it.`,
    {
      url: z.string().describe("URL to fetch"),
      // Optional, not .default(5000): the log tells a model that set none from one that asked for 5000.
      max_length: z.number().int().min(1).max(999999).optional().describe("Maximum number of characters to return (default 5000)."),
      start_index: z.number().int().min(0).default(0).describe("On return output starting at this character index, useful if a previous fetch was truncated and more context is required."),
      raw: z.boolean().default(false).describe("Get the actual HTML content of the requested page, without simplification."),
      title_only: z.boolean().default(false).describe("Return only the page's title line. The whole page is still fetched and stored; use this to verify that a link resolves and what it points to."),
    },
    async ({ url, max_length: asked, start_index, raw, title_only }) => {
      const t0 = Date.now();
      // max=<max_length> on the outcome line: the length the model asked for, max=default when it gave none (5000),
      // to see how much of a page a first answer carries.
      const max_length = asked ?? 5000, maxLog = ` max=${asked ?? "default"}`;
      // Log lines: the ID column holds the URL without scheme, cut to a PubMed ID's width; the full URL ends the line.
      const id = logId(url), put = (line: string) => log("fetch", id, `${line} ${url}`);
      // A PubMed, ClinicalTrials.gov, DailyMed or doi.org URL: answered from the library entry, in fetch's format —
      // the record's Markdown (PubMed: the abstract record; doi.org: the full text when stored), added first when missing.
      let rid = raw ? null : libraryIdForUrl(url);
      // A DOI PubMed indexes is answered as its PMID: the abstract record, no cascade.
      if (rid?.startsWith("doi:") && !entryExists(entryPaths(FH_EVIDENCE_DIR, "doi", parseId(rid).id!))) {
        try { const pm = await pmidForDoi(parseId(rid).id!); if (pm) rid = `pmid:${pm}`; } catch { /* PubMed unreachable: the normal add below */ }
      }
      if (rid) {
        const pid = parseId(rid);
        const paths = entryPaths(FH_EVIDENCE_DIR, pid.type!, pid.id!);
        const had = entryExists(paths);
        if (!had && pid.type === "pmid") {
          // only the PubMed record, stored at abstract level as the batch tool does — the full-text cascade runs later, when fh_library_add or fh_library_read asks
          const b = await fetchArticles([pid.id!], FH_EVIDENCE_DIR, `${pkg.name} ${pkg.version}`);
          if (b.rows[0]?.[6] === "not found" || !entryExists(paths)) { put(`library ${rid} error: pmid not found`); return { content: [{ type: "text", text: `Failed to fetch ${url}: pmid not found` }], isError: true }; }
        } else if (!had) { const added = JSON.parse((await addEntry(rid)).content[0].text) as Status; if (added.error) { put(`library ${rid} error: ${added.error}`); return { content: [{ type: "text", text: `Failed to fetch ${url}: ${added.error}` }], isError: true }; } }
        const file = pid.type === "pmid" ? paths.md : existsSync(paths.fulltextMd) ? paths.fulltextMd : paths.md;
        const md = existsSync(file) ? readFileSync(file, "utf8") : "";
        const text = title_only ? `Contents of ${url}:\n${(md.split("\n").find((l) => l.trim()) ?? "").trim()}` : fetchAnswer(url, md, "", max_length, start_index);
        bump("fetch", had);
        put(`library ${rid} ${had ? "cached" : "added"} chars=${text.length}${title_only ? " title" : maxLog}${start_index ? ` start=${start_index}` : ""}`);
        return { content: [{ type: "text", text }] };
      }
      const r = await libraryFetch(FH_EVIDENCE_DIR, url, { max_length, start_index, raw, title_only }, `${pkg.name} ${pkg.version}`, {
        onTry: put,
        onAlert: (line) => put(`!! ${line}`),
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0") + "s";
      if (r.meta) bump("fetch", r.cached);   // a page or a stored failure: from disk, or the network
      if (r.ok) {
        put(`${r.cached ? "cached" : `fetched ${secs}`} ${r.meta.format} retrieved_by=${r.meta.retrieved_by} fetched=${r.meta.fetched} chars=${r.text.length}${raw ? " raw" : ""}${title_only ? " title" : maxLog}${start_index ? ` start=${start_index}` : ""}`);
        return { content: [{ type: "text", text: r.text }] };
      }
      put(`${r.cached ? "cached failure" : `failed ${secs}`}: ${r.error.replace(url, "<url>")}`);
      return { content: [{ type: "text", text: r.error }], isError: true };
    }
  );

  // fh_clinicaltrials_search_studies(query | intervention | condition, status?, max_results?) —
  // a ClinicalTrials.gov search, cached for a week (src/trials.ts).
  // fh_pubmed_fetch_articles(pmids) — the old server's pubmed_fetch_articles
  // from the library: stored PMIDs from disk, the rest in one efetch, stored at
  // abstract level as fh_library_add's first stage (src/pubmedbatch.ts).
  server.tool(
    "fh_pubmed_fetch_articles",
    `Title, first author, year, publication types, retracted and library level for up to ${MAX_PMIDS} PubMed IDs in one call. Faster and far smaller than asking PubMed: known papers come from disk, the rest in one request, stored for every later call; rows as arrays in columns order, ~120 characters a paper. Level "not found": PubMed has no such record. For abstract or full text: fh_library_read.`,
    { pmids: z.array(z.string()).min(1).max(MAX_PMIDS).describe('PubMed IDs, "30955454" or "pmid:30955454", up to 200.') },
    async ({ pmids }) => {
      const t0 = Date.now();
      const r = await fetchArticles(pmids, FH_EVIDENCE_DIR, `${pkg.name} ${pkg.version}`);
      if (r.cached) bump("pubmed", true, r.cached);
      if (r.new) bump("pubmed", false, r.new);
      const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0") + "s";
      log("pubmed", `pmids:${r.rows.length}`, `articles ${secs} cached=${r.cached} new=${r.new}${r.not_found ? ` not_found=${r.not_found}` : ""}${r.invalid ? ` invalid=${r.invalid}` : ""}`);
      return { content: [{ type: "text" as const, text: compact({ columns: r.columns, rows: r.rows }) }] };
    }
  );

  // fh_pubmed_search_articles(query, max_results?, sort?, years?) — the
  // old server's pubmed_search_articles: esearch + one esummary, cached (src/pubmedsearch.ts).
  server.tool(
    "fh_pubmed_search_articles",
    `Search PubMed with its own query syntax (AND / OR, field tags like [pt], [ti], [mesh]); sort relevance | newest; years "2020-2026". Faster and far smaller than asking PubMed: the total and up to ${MAX_PAPERS} rows as arrays in columns order — PMID, title, first author, year, journal, publication types, PMCID when free full text exists, and the library level when the paper is already stored. The same search is answered from disk for ${searchCacheDays()} days. For a batch of PMIDs: fh_pubmed_fetch_articles; for abstract or full text: fh_library_read.`,
    {
      query: z.string().describe('PubMed query, full syntax: "tadalafil AND (systematic review[pt] OR meta-analysis[pt])".'),
      max_results: z.number().int().min(1).max(MAX_PAPERS).default(20).describe("Rows to return (1–100)."),
      sort: z.enum(["relevance", "newest"]).default("relevance").describe("relevance (PubMed's ranking) or newest (publication date, latest first)."),
      years: z.string().optional().describe('Publication years: "2020-2026", "2022-", "-2019" or "2022".'),
    },
    async (args) => {
      const t0 = Date.now();
      const r = await searchArticles(args, FH_EVIDENCE_DIR);
      const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0") + "s";
      if (!r.ok) { log("search", "pm:-", `error: ${r.error}`); return { content: [{ type: "text" as const, text: compact({ error: r.error }) }], isError: true }; }
      bump("search", r.cached);
      const q = r.result.query;
      log("search", `pm:${pubmedLogId(q)}`, `${r.cached ? "cached" : `searched ${secs}`} rows=${r.result.rows.length} total=${r.result.total}${q.sort !== "relevance" ? ` sort=${q.sort}` : ""}${q.years ? ` years=${q.years}` : ""} | ${q.query}`);
      return { content: [{ type: "text" as const, text: searchAnswer(r.result) }] };
    }
  );

  server.tool(
    "fh_clinicaltrials_search_studies",
    `Search ClinicalTrials.gov by free text, intervention or condition; status ongoing | completed | all; sort relevance | newest | largest | completion. Returns the total and up to ${MAX_TRIALS} rows as arrays in columns order: NCT ID, title, status, phase, enrollment ("~100" estimated), start, primary completion, primary outcome, conditions, interventions, has_results. Link: https://clinicaltrials.gov/study/<NCT ID>. Cached ${searchCacheDays()} days. One trial in detail: fh_clinicaltrials_get_study_record.`,
    {
      query: z.string().optional().describe("Free-text search across all fields (title, conditions, interventions, summary, …); AND / OR / NOT allowed."),
      intervention: z.string().optional().describe("Intervention or treatment, e.g. \"tadalafil\", \"cognitive behavioral therapy\"."),
      condition: z.string().optional().describe("Condition or disease, e.g. \"hypertension\", \"type 2 diabetes\"."),
      status: z.enum(["ongoing", "completed", "all"]).default("all").describe("ongoing: recruiting, not yet recruiting, active not recruiting, enrolling by invitation. completed: completed. all: no filter."),
      sort: z.enum(["relevance", "newest", "largest", "completion"]).default("relevance").describe("relevance (the registry's ranking), newest (last update first), largest (enrollment first), completion (completion date, latest first)."),
      max_results: z.number().int().min(1).max(MAX_TRIALS).default(20).describe("Rows to return (1–100)."),
    },
    async (args) => {
      const t0 = Date.now();
      const r = await searchTrials(args, FH_EVIDENCE_DIR);
      const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0") + "s";
      if (!r.ok) { log("search", "ct:-", `error: ${r.error}`); return { content: [{ type: "text" as const, text: compact({ error: r.error }) }], isError: true }; }
      bump("search", r.cached);
      const q = r.result.query, parts = [q.intervention && `intervention=${q.intervention}`, q.condition && `condition=${q.condition}`, q.query && `query=${q.query}`].filter(Boolean).join(" ");
      log("search", `ct:${trialsLogId(q)}`, `${r.cached ? "cached" : `searched ${secs}`} rows=${r.result.rows.length} total=${r.result.total} status=${q.status}${q.sort !== "relevance" ? ` sort=${q.sort}` : ""} | ${parts}`);
      return { content: [{ type: "text" as const, text: searchAnswer(r.result) }] };
    }
  );

  // fh_clinicaltrials_get_study_record(nct) / _get_study_results(nct, max_chars?) — thin answers
  // over the stored nct: entry (added first when missing): the review's detail
  // of one trial, and its posted results (src/trialrecord.ts).
  const nctEntry = async (id: string): Promise<{ paths: EntryPaths; requested: string } | { error: string }> => {
    const p = parseId(/^\d{8}$/.test(id.trim()) ? `nct:${id.trim()}` : id);
    if (p.error) return { error: p.error };
    if (p.type !== "nct") return { error: `not a trial ID: ${p.requested}` };
    const paths = entryPaths(FH_EVIDENCE_DIR, p.type!, p.id!);
    if (!entryExists(paths)) { const r = await addEntry(p.requested); const s = JSON.parse(r.content[0].text) as Status; if (s.error) return { error: s.error }; }
    return { paths, requested: p.requested };
  };
  server.tool(
    "fh_clinicaltrials_get_study_record",
    "One ClinicalTrials.gov trial as a review needs it: titles, status and why stopped, phase, design, enrollment, dates, sponsor, conditions, interventions, primary outcomes, eligibility, sites, result publications as pmid: IDs, has_results, brief summary. From the stored record; a missing trial is added first. The whole record: fh_library_read(\"nct:…\").",
    { nct: z.string().describe('The NCT ID: "nct:05173896", "NCT05173896" or the eight digits.') },
    async ({ nct }) => {
      const t0 = Date.now();
      const e = await nctEntry(nct);
      if ("error" in e) { log("trials", nct, `record error: ${e.error}`); return { content: [{ type: "text" as const, text: compact({ error: e.error }) }], isError: true }; }
      const raw = e.paths.fulltextRaw("json");
      const r = existsSync(raw) ? recordSummary(readFileSync(raw, "utf8")) : null;
      if (!r) { log("trials", e.requested, "record error: no stored record"); return { content: [{ type: "text" as const, text: compact({ error: "no stored record" }) }], isError: true }; }
      log("trials", e.requested, `record ${((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0")}s ${r.status ?? ""}${r.has_results ? " results" : ""} | ${r.title}`);
      return { content: [{ type: "text" as const, text: leanJson(r) }] };
    }
  );
  server.tool(
    "fh_clinicaltrials_get_study_results",
    "The posted results of one ClinicalTrials.gov trial — participant flow, baseline, every outcome measure as a table, adverse events — as Markdown from the stored record, capped at max_chars, outcome titles listed; fh_library_read(\"nct:…\", section: <title>) returns one measure whole. has_results false when the registry holds none. A missing trial is added first.",
    { nct: z.string().describe('The NCT ID: "nct:05173896", "NCT05173896" or the eight digits.'), max_chars: z.number().int().min(200).max(60000).default(6000).describe("Cap for the results text (default 6000).") },
    async ({ nct, max_chars }) => {
      const e = await nctEntry(nct);
      if ("error" in e) { log("trials", nct, `results error: ${e.error}`); return { content: [{ type: "text" as const, text: compact({ error: e.error }) }], isError: true }; }
      const md = existsSync(e.paths.fulltextMd) ? readFileSync(e.paths.fulltextMd, "utf8") : "";
      const r = resultsText(e.requested.replace(/^nct:/, "NCT"), md, max_chars);
      log("trials", e.requested, `results ${r.has_results ? `${r.outcomes.length} outcomes${r.truncated ? " truncated" : ""}` : "none"}`);
      return { content: [{ type: "text" as const, text: leanJson(r) }] };
    }
  );
}

// ---- Design notes: One ID per call, no batch, no concurrency limit ----
//
// Asked 2026-11-04 (AI4L audit, step 3): a review with 67 papers took about
// 3 minutes to add when every entry was cached, about 20 on first contact.
// Decided 2026-11-04: `fh_library_add` stays one ID per call, with no batch
// tool and no queue.
//
// * **The server does not serialise calls.** The MCP SDK runs each request
//   in its own handler; a log of 2026-11-04 shows twenty calls inside one
//   second. The minutes on a cached run are client round trips.
// * **No batch.** A batch has one response: on a first-contact paper the
//   cascade can run minutes, and a client timeout would lose every status in
//   it. One call per ID keeps a timeout to one paper and the log to one line
//   per call. The per-paper status is what the model puts in its table.
// * **Built and reverted the same day:** an instant return for stored entries
//   with upkeep in the background, a single worker for missing papers, a
//   bounded wait with a `queued` level. Any parallel scheme needs a loop the
//   model must follow (it cannot know which papers are stored), and that
//   complexity was not wanted.
