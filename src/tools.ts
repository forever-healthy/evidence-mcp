import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { applyFulltext, copyEntry, daysSince, emptyStatus, entryExists, fulltextNeverTried, readHeadLine, readMeta, readStatus, recordAttempts, refreshRecord, statusFromMeta, today, writeEntry, writeMeta, type Meta, type Status } from "./entry.js";
import { settings } from "./config.js";
import { attemptLabel, fulltextCascade } from "./cascade.js";
import type { EntryPaths } from "./layout.js";
import { parseId } from "./ids.js";
import { entryPaths, FH_EVIDENCE_DIR } from "./layout.js";
import { fetchPubmedXml, isRetractionNotice, parsePubmedXml, type Correction } from "./pubmed.js";
import { COUNTS_MAX_AGE_MS, libraryCounts, libraryInfo } from "./info.js";
import { assembleDeclarations, findSections, outline, readSection, search, type SearchResult } from "./read.js";
import { HOST, LOG_FILE, log } from "./log.js";
import { verifyConfig } from "./verify/config.js";
import { unlockerHealth } from "./unlock.js";
import { probe } from "./hosts.js";
import { decider } from "./verify/decider.js";
import { fetchSpl, parseSpl } from "./spl.js";
import { fetchStudy, parseStudy } from "./ctgov.js";
import { fetchCrossref, fetchCsl, openAlexAbstract, parseCrossref, parseCsl, pmidForDoi } from "./doi.js";
import { renderAbstractMd, writeDoiEntry, writeLabelEntry, writeStudyEntry } from "./entry.js";
import { fetchAnswer, libraryFetch, libraryIdForUrl, logId } from "./urlfetch.js";
import { verifyCached } from "./verify/cache.js";
import { bump, currentStats } from "./stats.js";
import { compact, leanJson, readAnswer, searchAnswer, statusAnswer, verdictAnswer } from "./json.js";
import { MAX_RESULTS as MAX_TRIALS, searchCacheDays, searchTrials } from "./trials.js";
import { MAX_RESULTS as MAX_PAPERS, searchArticles } from "./pubmedsearch.js";
import { MAX_RESULTS as MAX_LABELS, searchLabels } from "./dailymedsearch.js";
import { webSearch, webSearchConfigured } from "./websearch.js";
import { citingArticles, MAX_RESULTS as MAX_CITING } from "./citations.js";
import { recordSummary, resultsText } from "./trialrecord.js";
import { fetchArticles, MAX_PMIDS } from "./pubmedbatch.js";
import { freshMissing, missingNote, rememberMissing } from "./missing.js";
import { getAspects, mapCounts, NO_ASPECT, NOT_BUILT, notBuilt } from "./items.js";
import { extractCharacteristics } from "./characteristics.js";
import { mapTables } from "./tables.js";
import { jobAnswer, jobRunning, readJob, startJob, waitSecs } from "./mapjob.js";
import { getGaps, reportGap } from "./gaps.js";
import { evidenceMapEnabled, getQueryPerformance } from "./evidencemap.js";
import { discoverMap, liveDeps } from "./discovery.js";
import { createEvid, DEFAULT_MAX_CHARS as EVID_MAX_CHARS, evidEnabled, findEvids, getObject, listObjects, openEvid, putObject } from "./evid.js";

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

// Running from a source checkout (a .git folder beside package.json), not from the published package: said in
// place of the version number, which a checkout shares with the last release — the commit it stands on and when
// it was built. null: the published package.
export const localBuild: string | null = (() => {
  try {
    const root = new URL("../", import.meta.url);
    const head = readFileSync(new URL(".git/HEAD", root), "utf8").trim();
    const ref = /^ref: (.+)$/.exec(head)?.[1];
    let commit = head;
    if (ref) { try { commit = readFileSync(new URL(`.git/${ref}`, root), "utf8").trim(); } catch { commit = /^([0-9a-f]{40}) /m.exec(readFileSync(new URL(".git/packed-refs", root), "utf8").split("\n").find((l) => l.endsWith(` ${ref}`)) ?? "")?.[1] ?? ""; } }
    const t = statSync(new URL(import.meta.url)).mtime, p2 = (n: number) => String(n).padStart(2, "0");
    return `local source${commit ? ` · commit ${commit.slice(0, 7)}` : ""} · built ${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
  } catch { return null; }
})();
// What the server says it is: the package and its version, or the local source.
export const buildLabel = `${pkg.name} ${localBuild ?? pkg.version}`;

// Server-level instructions surfaced to the connecting agent/model at
// initialize (the MCP `instructions` field). This is the one place to explain,
// up front, what the library is and how the tools fit together — so an agent
// can use it without having to infer everything from tool names.
export const INSTRUCTIONS = `evidence-mcp keeps a local library of scientific articles, FDA drug labels, clinical trial records and web pages, so you can check what a source actually says. Each record is downloaded once, stored as Markdown and read in small pieces: answers are small JSON, the document never enters your context — except fh_fetch_url, the standard fetch tool with a cache.

IDs — "type:value", one per call (fh_pubmed_fetch_articles: up to 200 PMIDs)
- pmid:30955454 — an article; bare digits count as a PMID.
- doi:10.… — an article; a DOI PubMed indexes is stored under its PMID, any other comes from Crossref.
- dailymed:<set ID> — an FDA label, current version; the set ID from fh_dailymed_search_labels or the label URL's "setid=".
- nct:05173896 — a ClinicalTrials.gov record, current version; NCT05173896 is accepted.
A URL is no ID: send the ID of a PubMed, doi.org, ClinicalTrials.gov or DailyMed URL; any other page: fh_fetch_url.

Tools
- Library: fh_library_add, fh_library_status, fh_library_read (outline, one section, or the passages for a query), fh_verify_claim (does this one source state this one finding?).
- Search: fh_pubmed_search_articles, fh_pubmed_fetch_articles, fh_citing_articles, fh_clinicaltrials_search_studies, fh_dailymed_search_labels${webSearchConfigured() ? ", fh_web_search (instead of the built-in web search)" : ""}.
- Trials: fh_clinicaltrials_get_study_record, fh_clinicaltrials_get_study_results.
- Web: fh_fetch_url, for every URL that is not an article, label or trial record.
${evidEnabled() ? "- EVID: fh_evid_create, fh_evid_find, fh_evid_list_objects, fh_evid_put, fh_evid_get — a store that outlives the session.\n" : ""}${evidenceMapEnabled() ? `- Evidence map — a guide to the articles a review of a topic should not overlook (not complete: your own searches and your review's rules still decide), by section of the review (${mapTables().sections.map((x) => x.name).join(", ")}): fh_evmap_create_map (topic in, EVID out; takes minutes), fh_evmap_get_map (the state, then the map), fh_evmap_get_info (its topic, state and counts), fh_evmap_report_gap (before adding an article the map did not give: what it has instead). Not needed to use a map: fh_evmap_get_query_performance, fh_evmap_get_gaps.\n` : ""}- fh_info: this server's version and the library.

Rules
- fh_library_read and fh_verify_claim store a missing record themselves (added: true); no fh_library_add first.
- Many articles to look over: fh_library_read with abstract_only: true for each, then without it only where the full text is needed.
- level: "full_text", "abstract" or "title". fulltext "not tried": stored from PubMed alone; the next read without abstract_only, verify or add searches for the full text.
- citable false: retracted, or nothing to read; comment says which, corrections lists the notices.
- "pmid not found" and the like: no service knows the ID; remembered for a day. "invalid id": the ID is malformed.
- fh_library_add, fh_library_read and fh_verify_claim may run in parallel; calls on the same missing record share one add.
- Answers leave out null fields and empty lists and echo nothing you sent.
- Every action is one line in <library>/logs/evidence.log.`;

const idSchema = z.string().describe('ID as "type:value": an article "pmid:30955454" (bare digits count as pmid) or "doi:10.5812/asjsm.110753" (an article PubMed does not index; a DOI PubMed indexes is taken as its PMID), a drug label "dailymed:<set ID>" (the set ID from fh_dailymed_search_labels, or the "setid=" value of its DailyMed URL), or a trial record "nct:05173896" (the eight digits; nct:NCT05173896 and a bare NCT05173896 are accepted).');

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
const modelFailure = (error: string, cfg: { model: string } | null) => error.startsWith("no decision model configured") || (!!cfg && error.startsWith(`${cfg.model}:`));

// The record types in the TUI's order: pmid, doi, nct, dailymed, url, then any other.
const TYPE_ORDER = ["pmid", "doi", "nct", "dailymed", "url"];
const typeOrder = (types: string[]): string[] => [...TYPE_ORDER.filter((t) => types.includes(t)), ...types.filter((t) => !TYPE_ORDER.includes(t)).sort()];

export function registerTools(server: McpServer): void {
  const SECTIONS = mapTables().sections.map((x) => x.name).join(", ");   // the map's sections, as the discovery prompt in force sets them
  // IDs are "type:value" (pmid:30955454, doi:10.…, pmc:PMC…, nct:NCT…); bare
  // digits count as pmid. One ID per call — no batches (the GitHub issues for what is not).

  // fh_library_add(id) — build or complete the entry through the retrieval
  // cascade; returns its status. Idempotent: an existing entry is returned as
  // is (v0.1 never upgrades an entry; full-text retries come with the tiers).
  // Runs the full-text cascade on an abstract-level entry and writes the
  // result: files + upgraded meta on a hit, new attempts on misses.
  async function completeFulltext(paths: EntryPaths, meta: Meta, requested: string): Promise<{ meta: Meta; ran: boolean }> {
    const article = { title: meta.title, pmid: meta.pmid, pmcid: meta.pmcid, doi: meta.doi, headLine: readHeadLine(paths) };
    // A tier whose attempts were logged line by line closes with a bare
    // "failed" — the reasons are the lines above; its attempts entry keeps them.
    const tried = new Set<string>();
    let ran = false;   // any tier considered at all — false when every tier is in cooldown or permanently failed
    const { hit } = await fulltextCascade(article, meta.attempts, (e) => {
      // "!! …": a service refused the deployment, not the article.
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
    "Download and store one record — an article (pmid:, doi:), a drug label (dailymed:<set ID>) or a trial record (nct:<8 digits>) — and return its status JSON (fields: fh_library_status). An article gets its record, abstract and correction notices from PubMed (Crossref for a DOI PubMed does not index), then the full text from the configured sources; a label or trial record is stored as a full text. A stored full text is returned without any download; an abstract-level record retries only sources that failed transiently; a record older than 30 days gets its notices re-read.",
    { id: idSchema },
    ({ id }) => addEntry(id)
  );

  // One add in flight per ID: two parallel reads of an article not yet in the
  // library (reads may run in parallel) share one cascade instead of racing.
  const inflight = new Map<string, Promise<ReturnType<typeof json>>>();
  // Stored from PubMed alone, no full-text source tried yet (src/entry.ts fulltextNeverTried).
  const untried = (paths: ReturnType<typeof entryPaths>): boolean => { try { return entryExists(paths) && fulltextNeverTried(readMeta(paths)); } catch { return false; } };

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
        // what kind of study it is, read from the abstract when a screening model is configured — the add does not wait for it
        if (record.abstract.length) void extractCharacteristics(FH_EVIDENCE_DIR, parsed.id!, renderAbstractMd(record)).then((line) => { if (line) log("add", parsed.requested, line); });
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
    "Read-only status of the library entry for one ID — an article, a drug label or a trial record: the same status JSON as fh_library_add, or level \"missing\" when there is no entry. Never fetches. Fields: pmid, pmcid, setid, nctid, publications, year, publication_types, retracted, corrections ({type, pmid, source}), citable, comment, has_abstract, level (full_text | abstract | title), fulltext (\"not tried\": no source tried yet; \"stored\": the full text exists, an abstract_only read did not use it), version, retrieved_by, glyphs_unresolved (symbols the PDF font lost), error.",
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
  // not the whole article: the deliberate, small flow through context for claim
  // verification. Outline first, then a section by heading or passages by query.
  server.tool(
    "fh_library_read",
    "One piece of a stored document's Markdown, never the whole. No section/query: the outline (headings with word counts; full text or abstract only). section: that heading's own text (case-insensitive substring; a repeated heading as \"Participants [3/12]\"), capped at max_chars, its subsections listed. query: passages holding every term, each a window of at most 1000 chars with its section, best first, at most max_hits (more: how many further passages match); partial: true with missing_terms when no passage holds them all. section and query together: inside that section. Case, accents, hyphens, plurals and -ed/-ing forms match; a matching table row comes with its header row. section \"Abstract\" on a full text without one: the stored abstract; \"Declarations\": funding, conflicts of interest, acknowledgements, ethics. A missing article is added first (added: true). abstract_only: true reads only the abstract, at once — use it whenever the abstract is enough (screening, design, size, main finding); without it, an article whose full text was never searched for gets a search for the full text first (seconds, up to a minute, once).",
    {
      id: idSchema,
      section: z.string().optional().describe("Heading from the outline (case-insensitive substring)."),
      query: z.string().optional().describe("Two or three distinctive terms the article itself would use — a measure and a unit, an outcome and a group, a compound name — not the claim. Passages holding all of them are returned, else the best partial matches. With section: inside that section."),
      max_chars: z.number().int().positive().optional().describe("Cap for section text (default 6000); passages are capped at 1000 chars each regardless."),
      max_hits: z.number().int().positive().optional().describe("Cap for query passages (default 5)."),
      abstract_only: z.boolean().optional().describe("true: the abstract only, at once, without triggering a search for the full text; section and query search the abstract. A missing pmid: is stored from PubMed alone; a missing doi: is added normally first; dailymed: and nct: ignore it. Use it whenever the abstract answers the question (topic, design, population, size, main result, worth reading?); not for details only the full text holds, nor for checking a claim. fulltext \"stored\" or \"not tried\": a read without the flag gets more."),
    },
    async ({ id, section, query, max_chars, max_hits, abstract_only }) => {
      const parsed = parseId(id);
      const out = (o: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: readAnswer(o) }] });
      if (parsed.error) { log("read", parsed.requested, `error ${parsed.error}`); return out({ requested: parsed.requested, error: parsed.error }); }
      const paths = entryPaths(FH_EVIDENCE_DIR, parsed.type!, parsed.id!);
      // Not in the library yet: added first, as fh_library_add would (its lines
      // in the log), then read. An article the add cannot build stays an error.
      let added = false;
      // abstract_only on an article by PMID: never the full-text cascade — a missing article is
      // stored from PubMed alone (the batch path, as fh_pubmed_fetch_articles); its
      // full text stays "not tried" for a later read without the flag.
      const abstractOnly = abstract_only === true && (parsed.type === "pmid" || parsed.type === "doi");
      if (abstractOnly && !entryExists(paths) && parsed.type === "pmid") {
        log("read", parsed.requested, "missing adding abstract only");
        const r = await fetchArticles([parsed.id!], FH_EVIDENCE_DIR).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
        if (!entryExists(paths)) { const why = "error" in r ? r.error : "PubMed has no such record"; log("read", parsed.requested, `error ${why}`); return out({ requested: parsed.requested, entry: paths.entry, error: `not in the library and PubMed gave no record: ${why}` }); }
        added = true;
      }
      if (!entryExists(paths) || (!abstractOnly && untried(paths))) {
        log("read", parsed.requested, entryExists(paths) ? "untried adding first" : "missing adding first");
        const r = JSON.parse((await addEntry(id)).content[0].text) as { error?: string };
        if (!entryExists(paths)) { log("read", parsed.requested, `error ${r.error ?? "fh_library_add failed"}`); return out({ requested: parsed.requested, entry: paths.entry, error: `not in the library and fh_library_add failed: ${r.error ?? "unknown"}` }); }
        added = true;
      }
      const stored = existsSync(paths.fulltextMd);
      if (abstractOnly && !existsSync(paths.md)) { log("read", parsed.requested, "error abstract only: no abstract stored"); return out({ requested: parsed.requested, entry: paths.entry, error: `no abstract stored for ${parsed.requested}${stored ? "; a full text is: read again without abstract_only" : ""}` }); }
      const full = stored && !abstractOnly;
      const md = readFileSync(full ? paths.fulltextMd : paths.md, "utf8");
      const text = full ? "full_text" : "abstract";
      // abstract_only: whether more can be had — a full text stored, or never searched for.
      const more = abstractOnly ? (stored ? { fulltext: "stored" } : untried(paths) ? { fulltext: "not tried" } : {}) : {};
      const base = { requested: parsed.requested, entry: paths.entry, text, ...more, ...(added ? { added: true } : {}) };
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

  // fh_verify_claim(claim, id) — one finding of the review against one article
  // it cites, judged by the decision model FH_VERIFY_* names (src/verify/verify.ts design notes for the decisions).
  // One claim, one article per call: the audit gets one row per source, and a
  // fixer can drop the one source that does not carry the finding.
  server.tool(
    "fh_verify_claim",
    "Does one source state one finding of a review? claim: the finding as a complete statement (subject, intervention, outcome, number), without citations or the review's framing, and only what this source reports. id: one source the review cites for it — article, drug label (dailymed:…) or trial record (nct:…); added first when missing. fulltext \"not tried\": a search for the full text first (seconds, up to a minute, once). The server reads the stored text and asks a decision model; nothing enters your context. One claim, one source: a finding backed by three articles is three calls; a summary of several trials is stated by none of them. verdict: supported | not_supported (the full text does not state it — fh_library_read with a query shows what it says; or only the title is stored — reason says so) | unverifiable (only the abstract is stored and does not state it — reason says so; the same until a full text is stored) | error (claim refused: under four words, a fragment, carrying citations; add failed; no model; model failure). basis: full_text | abstract | title. glyphs_unresolved: numbers of the claim that stand next to a symbol the PDF's font lost (−, ±, ≤); such a claim is checked again against the abstract and without the symbol, and is unverifiable when only the symbol is missing. superseded: true when a stored correction replaced the claim's figure. score: the probability that the source states the claim, with every judged verdict; null: no judgement. The same claim on the same stored text answers from disk for 30 days.",
    {
      claim: z.string().describe("One finding as a complete statement (subject, intervention, outcome, number), built from the review's words, without its citations and framing."),
      id: idSchema,
    },
    async ({ claim, id }) => {
      const t0 = Date.now();
      const cfg = verifyConfig();
      // Not in the library yet: added first (fh_library_add's lines in the log); the fh_library_add's own failure is verify's error then.
      const pid = parseId(id);
      if (!pid.error) {
        const vp = entryPaths(FH_EVIDENCE_DIR, pid.type!, pid.id!);
        if (!entryExists(vp)) { log("verify", pid.requested, "missing adding first"); await addEntry(id); }
        else if (untried(vp)) { log("verify", pid.requested, "untried adding first"); await addEntry(id); }
      }
      // The cache in front of the model (src/verify/cache.ts): the same claim on the same stored text answers from disk.
      const { cached, ...r } = await verifyCached(claim, id, cfg, cfg ? decider(cfg) : null, FH_EVIDENCE_DIR);
      if (!r.error && r.score !== null) bump("verify", cached);   // a judgement: from disk, or the model
      // Time first, padded so the columns line up ("  2.1s", " 13.1s"), then
      // the verdict, the basis, the score, "cached" when no model ran, and the whole claim (the provider is in fh_info and the TUI's decider line).
      // The time when the model ran; "cached" in its place when the verdict came from disk (milliseconds).
      const secs = `${((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0")}s`;   // "00.7s", "13.7s": two digits before the dot, one space after the ID
      // An error is no verdict: "error <why>", not "verdict=error" — the model's service down, or a claim refused (2026-11-11).
      log("verify", r.id, r.error ? `${modelFailure(r.error, cfg) ? "!! " : ""}${secs} ${"error".padEnd(20)} ${r.error} | ${claim}` : `${cached ? "cached" : secs} verdict=${r.verdict.padEnd(12)} basis=${r.basis!.padEnd(9)} score=${r.score === null ? "-    " : r.score.toFixed(3)}${r.windows > 1 ? ` windows=${r.windows}` : ""}${r.superseded ? " superseded" : ""}${r.glyphs_unresolved ? ` glyphs=${r.glyphs_unresolved}` : ""} | ${claim}`);
      return { content: [{ type: "text" as const, text: verdictAnswer(r) }] };
    }
  );

  // fh_info() — the server and the whole library in one JSON: package,
  // version and log first (which build is loaded), then counts by type and
  // level, retracted count.
  server.tool(
    "fh_info",
    `The server and the whole library as JSON: this server's package name and version (which build is loaded), its log file; evidence directory (evidence_dir) and host; entry count and size on disk, by type and by level (by_type, by_level), as of counted — up to ${COUNTS_MAX_AGE_MS / 60_000} minutes old, counted again in the background; per type (pmid, doi, dailymed, nct, url — pages stored by fh_fetch_url) the entries by level (full_text, abstract, title), retractions and fulltext_not_tried (articles stored from PubMed alone) (types); counts of retracted and not-citable entries and of errata, expressions of concern and updates (retracted, not_citable, errata, concerns, updates); the retrieval sources in run order and which are off (tiers); the multi-stage download (download): the Playwright servers with the version they must run, the Chrome stages, whether an unlocker is configured; the configuration and where each value came from — environment, .env or default, never the value (config); the decision model behind fh_verify_claim and whether it answers right now (verify);${evidEnabled() ? " how many EVIDs there are and how many hold an evidence map (evid: entries, evidence_maps);" : ""}${evidenceMapEnabled() ? " the discovery, screening and ranking models of fh_evmap_create_map and where its prompts come from (evidence_map);" : ""}${webSearchConfigured() ? " the providers behind fh_web_search (web_search);" : ""} the unlockers and whether each answers right now (unlockers); our own stage hosts — fetch proxy, Playwright servers, Chrome — and whether each is reachable right now (stages); this server's cache hits and misses since it started (cache): verify (fh_verify_claim), fetch (fh_fetch_url), search (the search tools), pubmed (fh_pubmed_fetch_articles, per PMID).`,
    {},
    async () => {
      const info = libraryInfo(FH_EVIDENCE_DIR, HOST);
      // The library's counts: from the shared counts file, counted again in the background when old (src/info.ts).
      const countsP = libraryCounts(FH_EVIDENCE_DIR);
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
      const counts = await countsP;
      log("info", null, `entries=${counts ? counts.entries : "counting"}${counts && Object.keys(counts.by_type).length ? ` (${typeOrder(Object.keys(counts.by_type)).map((t) => `${t} ${counts.by_type[t]}`).join(", ")})` : ""}${info.verify ? ` verify ${info.verify.model} ${info.verify.ok ? `ok ${info.verify.ms} ms` : `down: ${info.verify.error}`}` : " verify not configured"}${info.unlockers.map((u) => ` unlocker ${u.provider} ${u.ok ? `ok ${u.ms} ms` : `down: ${u.error}`}`).join("")}${info.stages.map((s) => ` stage ${s.name} ${s.up ? `up ${s.ms} ms` : `down: ${s.error}`}`).join("")}`);
      // This process's cache counters since it started (every server publishes them under <library>/.servers/ as well).
      const s = currentStats();
      const cache = s ? { since: s.started, verify: s.verify, fetch: s.fetch, search: s.search, pubmed: s.pubmed } : null;
      return { content: [{ type: "text" as const, text: compact({ package: pkg.name, version: localBuild ?? pkg.version, log: LOG_FILE, ...info, ...(counts ?? { counted: null, counting: "the library is being counted for the first time — call again in a minute" }), cache }) }] };
    }
  );

  // fh_fetch_url(url, max_length?, start_index?, raw?) — the standard fetch
  // tool, cached: the answer is the reference fetch server's, the page comes
  // from disk when young enough, else through the multi-stage download (src/urlfetch.ts).
  server.tool(
    "fh_fetch_url",
    `Fetch a web page as Markdown: the standard fetch tool, cached and hardened. Use it for any URL instead of a plain fetch or a browser. A page fetched in the last ${settings().refresh_after_days} days is answered from disk in milliseconds; a page a plain fetch cannot get (403, rate limit, bot wall, script-rendered) is fetched through the configured browsers and unlockers in this one call. PDFs come back as Markdown; XML, JSON and other text as is. To verify a link, title_only returns just its title line. A PubMed, ClinicalTrials.gov, DailyMed or doi.org URL is answered from the library's record of it. A failed fetch is remembered for ${settings().retry_after_days} d.`,
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
        put(`library ${rid} chars=${text.length}${title_only ? " title" : maxLog}${start_index ? ` start=${start_index}` : ""} ${had ? "cached" : "added"}`);
        return { content: [{ type: "text", text }] };
      }
      const r = await libraryFetch(FH_EVIDENCE_DIR, url, { max_length, start_index, raw, title_only }, `${pkg.name} ${pkg.version}`, {
        onTry: put,
        onAlert: (line) => put(`!! ${line}`),
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0") + "s";
      if (r.meta) bump("fetch", r.cached);   // a page or a stored failure: from disk, or the network
      if (r.ok) {
        // "ok", then the time — or "cached" in its place when nothing went out, as on a verify or search line
        put(`ok ${r.cached ? "cached" : secs} ${r.meta.format} retrieved_by=${r.meta.retrieved_by} fetched=${r.meta.fetched} chars=${r.text.length}${raw ? " raw" : ""}${title_only ? " title" : maxLog}${start_index ? ` start=${start_index}` : ""}`);
        return { content: [{ type: "text", text: r.text }] };
      }
      // The agent gets the standard fetch tool's words ("Failed to fetch <url> - status code 404"); the log,
      // whose line says failed and ends with the URL, only the reason: "failed: HTTP 404", "failed: invalid URL".
      const why = r.error.replace(url, "<url>").replace(/^Failed to fetch <url> - status code (\d+)$/, "HTTP $1").replace(/^Failed to fetch <url>: /, "");
      put(`failed ${r.cached ? "cached" : secs}: ${why}`);
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
    `Title, first author, year, publication types, retracted and library level for up to ${MAX_PMIDS} PubMed IDs in one call. Faster and far smaller than asking PubMed: known articles come from disk, the rest in one request, stored for every later call; rows as arrays in columns order, ~120 characters an article. design, participants and population where known: what kind of study it is, read from the abstract by a model. Level "not found": PubMed has no such record. For abstract or full text: fh_library_read.`,
    { pmids: z.array(z.string()).min(1).max(MAX_PMIDS).describe('PubMed IDs, "30955454" or "pmid:30955454", up to 200.') },
    async ({ pmids }) => {
      const t0 = Date.now();
      const r = await fetchArticles(pmids, FH_EVIDENCE_DIR, `${pkg.name} ${pkg.version}`);
      if (r.cached) bump("pubmed", true, r.cached);
      if (r.new) bump("pubmed", false, r.new);
      const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0") + "s";
      // The time only when PubMed was asked: every PMID from disk answers in milliseconds.
      log("pubmed", `pmids:${r.rows.length}`, `articles ${r.asked ? `${secs} ` : ""}cached=${r.cached} new=${r.new}${r.not_found ? ` not_found=${r.not_found}` : ""}${r.invalid ? ` invalid=${r.invalid}` : ""}`);
      return { content: [{ type: "text" as const, text: compact({ columns: r.columns, rows: r.rows }) }] };
    }
  );

  // fh_pubmed_search_articles(query, max_results?, sort?, years?) — the
  // old server's pubmed_search_articles: esearch + one esummary, cached (src/pubmedsearch.ts).
  server.tool(
    "fh_pubmed_search_articles",
    `Search PubMed with its own query syntax (AND / OR, field tags like [pt], [ti], [mesh]); sort relevance | newest; years "2020-2026". Faster and far smaller than asking PubMed: the total and up to ${MAX_PAPERS} rows as arrays in columns order — PMID, title, first author, year, journal, publication types, PMCID when free full text exists, and the library level when the article is already stored. The same search is answered from disk for ${searchCacheDays()} days. For a batch of PMIDs: fh_pubmed_fetch_articles; for abstract or full text: fh_library_read.`,
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
      if (!r.ok) { log("search", "pubmed", `${r.input ? "error" : `failed ${secs}`} ${r.error} | ${args.query}`); return { content: [{ type: "text" as const, text: compact({ error: r.error }) }], isError: true }; }
      bump("search", r.cached);
      const q = r.result.query;
      log("search", "pubmed", `ok ${r.cached ? "cached" : secs} rows=${r.result.rows.length} total=${r.result.total}${q.sort !== "relevance" ? ` sort=${q.sort}` : ""}${q.years ? ` years=${q.years}` : ""} | ${q.query}`);   // "cached" where the time would be: no request went out
      return { content: [{ type: "text" as const, text: searchAnswer(r.result) }] };
    }
  );

  // fh_citing_articles(id, types?, years?, sort?, max_results?) (#75); src/citations.ts.
  server.tool(
    "fh_citing_articles",
    `The articles that cite an article, as rows in fh_pubmed_search_articles' columns: PMID, title, first author, year, journal, publication types, PMCID, library level. Use it for a trial's follow-ups, later meta-analyses that include it, guidelines (sort: cited) and comments on it.
- types: PubMed publication types, any of them; an article without one (many plain articles, some guidelines) never matches.
- Comments: with comment, letter or editorial in types, the comments PubMed links to the article come first, of any year and type, and comments_on lists their PMIDs. The other rows only cite the article and are mostly about something else.
- years and sort newest go by the year column.
- At most ${MAX_CITING} rows, no paging: for more, narrow with types or years, or sort: cited. total counts every match.
Citations from OpenAlex. Cached ${searchCacheDays()} days.`,
    {
      id: z.string().describe('The cited article: "pmid:18378520" or "doi:10.1056/NEJMoa0801317".'),
      types: z.array(z.string()).optional().describe('Publication types, any of them: "meta-analysis", "systematic review", "randomized controlled trial", "review", "guideline", "comment", "letter", "editorial".'),
      years: z.string().optional().describe('Publication years of the citing articles, as in the year column: "2020-2026", "2022-", "-2019" or "2022". Not applied to the comments PubMed links.'),
      sort: z.enum(["newest", "cited"]).default("newest").describe("newest (latest year first) or cited (most cited first)."),
      max_results: z.number().int().min(1).max(MAX_CITING).default(20).describe("Rows to return (1–100)."),
    },
    async (args) => {
      const t0 = Date.now();
      const r = await citingArticles(args, FH_EVIDENCE_DIR);
      const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0") + "s";
      if (!r.ok) { log("search", "citing", `${r.input ? "error" : `failed ${secs}`} ${r.error} | ${args.id}`); return { content: [{ type: "text" as const, text: compact({ error: r.error }) }], isError: true }; }
      bump("search", r.cached);
      const q = r.result.query;
      log("search", "citing", `ok ${r.cached ? "cached" : secs} rows=${r.result.rows.length} total=${r.result.total}${r.result.comments_on ? ` comments_on=${r.result.comments_on.length}` : ""}${q.types ? ` types=${q.types.join(",")}` : ""}${q.years ? ` years=${q.years}` : ""}${q.sort !== "newest" ? ` sort=${q.sort}` : ""} | ${q.id}`);
      const { total, comments_on, columns, rows } = r.result;
      return { content: [{ type: "text" as const, text: compact({ total, comments_on, columns, rows }) }] };
    }
  );

  // fh_evid_* — development only, offered with FH_EVID_ENABLED (#77); src/evid.ts,
  // README-evid.md, stuff/evid/architecture.md.
  if (evidEnabled()) {
    const answer = (r: { ok: boolean } & Record<string, unknown>) => {
      const { ok, ...rest } = r;
      return { content: [{ type: "text" as const, text: compact(rest) }], ...(ok ? {} : { isError: true }) };
    };
    server.tool(
      "fh_evid_create",
      "Create an EVID: a store that outlives the session, named by its metadata. metadata: any fields, any JSON values (e.g. { \"topic\": \"…\" }); fixed once created — a fact known only later is an object (fh_evid_put). The server adds created (UTC) and returns the EVID (evid:<16 hex digits>, a hash of the metadata). Every create is a new EVID, even with the same fields.",
      { metadata: z.record(z.any()).describe("The fields describing what the EVID is for; any JSON values. created is added by the server.") },
      async ({ metadata }) => {
        const r = createEvid(FH_EVIDENCE_DIR, metadata);
        log("evid", r.ok ? r.evid : null, r.ok ? `created fields=${Object.keys(metadata).join(",")}` : `create error ${r.error}`);
        return answer(r.ok ? { ok: true, evid: r.evid, created: r.metadata.created } : r);
      }
    );
    server.tool(
      "fh_evid_find",
      "The EVIDs whose metadata has every given field, with their metadata. A text matches when the stored text holds every word given, case ignored (\"telmisartan\" finds \"Telmisartan for Health & Longevity\"); other values must be equal. Equal matches first, then newest first. query {} lists all.",
      {
        query: z.record(z.any()).describe('Fields and values, e.g. { "topic": "Telmisartan for Health & Longevity" } or { "topic": "telmisartan" }.'),
        max_results: z.number().int().min(1).max(100).default(20).describe("EVIDs to return (1–100); total counts every match."),
      },
      async ({ query, max_results }) => {
        const r = findEvids(FH_EVIDENCE_DIR, query, max_results);
        log("evid", "find", r.ok ? `ok total=${r.total} | ${JSON.stringify(query)}` : `error ${r.error}`);
        return answer(r);
      }
    );
    server.tool(
      "fh_evid_list_objects",
      "An EVID's metadata and its objects: name, type, size in bytes, when last written, previous: true when a replaced version is kept.",
      { evid: z.string().describe("The EVID, \"evid:\" and 16 hex digits.") },
      async ({ evid }) => {
        const r = listObjects(FH_EVIDENCE_DIR, evid);
        log("evid", r.ok ? r.evid : evid, r.ok ? `list objects=${r.objects.length}` : `list error ${r.error}`);
        return answer(r);
      }
    );
    server.tool(
      "fh_evid_put",
      "Store an object in an EVID. name: lowercase letters, digits, _ and -, then the extension, which sets the type: .json, .csv (RFC 4180, a header row), .txt, .md; at most 64 characters, no folders. An invalid name is refused with the valid form; content that does not parse as its type is refused. An existing object of that name is replaced and kept as its previous version (one only). Nothing can be deleted.",
      {
        evid: z.string().describe("The EVID."),
        name: z.string().describe('The object\'s name, e.g. "notes.md", "papers.csv".'),
        content: z.string().describe("The whole object as text."),
      },
      async ({ evid, name, content }) => {
        const r = putObject(FH_EVIDENCE_DIR, evid, name, content);
        log("evid", evid, r.ok ? `put ${name} ${r.size}B${r.replaced ? " replaced" : ""}` : `put error ${r.error}`);
        return answer(r);
      }
    );
    server.tool(
      "fh_evid_get",
      `Read an object of an EVID, whole or in pieces, as fh_library_read reads a document. No section/query: the object, when it fits max_chars (default ${EVID_MAX_CHARS}); else its outline (.md: headings with word counts; .csv: columns and row count; .json: keys; .txt: lines and words). section (.md): that heading's own text, its subsections listed. query: .md/.txt the passages holding every term, best first; .csv the rows holding every term, with the columns. lines "a-b": .md/.txt those lines, .csv those data rows. previous: true reads the version before the last put. name metadata.json: the metadata.`,
      {
        evid: z.string().describe("The EVID."),
        name: z.string().describe('The object\'s name, e.g. "notes.md".'),
        section: z.string().optional().describe(".md only: a heading, case-insensitive substring."),
        query: z.string().optional().describe("Two or three distinctive terms."),
        max_chars: z.number().int().positive().optional().describe(`Cap for the object or section text (default ${EVID_MAX_CHARS}).`),
        max_hits: z.number().int().positive().optional().describe("With query: passages (default 5) or csv rows (default 50)."),
        previous: z.boolean().optional().describe("true: the previous version."),
        lines: z.string().optional().describe('"a-b", "a" or "a-" (1-based): .md/.txt lines; .csv data rows, header as columns. Answer: first, last, total; cut when max_chars is reached.'),
      },
      async ({ evid, name, ...opts }) => {
        const r = getObject(FH_EVIDENCE_DIR, evid, name, opts);
        log("evid", evid, r.ok ? `get ${name}${opts.previous ? " previous" : ""}${opts.section ? ` section=${opts.section}` : ""}${opts.query ? ` query=${opts.query}` : ""}${opts.lines ? ` lines=${opts.lines}` : ""}${"too_large" in r ? " outline" : ""}` : `get error ${r.error}`);
        return answer(r);
      }
    );
  }

  // fh_evmap_create_map — development only, offered with
  // FH_EVMAP_ENABLED (#78); src/evidencemap.ts, the screening in src/screen.ts.
  if (evidenceMapEnabled()) server.tool(
    "fh_evmap_create_map",
    `Builds the evidence map of a topic: the PubMed articles a review should not overlook, in the sections of the review — ${SECTIONS}. The server writes the queries. topic: makes a new EVID with metadata { "topic": <as given> } and builds its map — every call a new one, so ${evidEnabled() ? `look first: fh_evid_find({ "topic": <the intervention> })` : "keep the EVID it answers with"}; two maps of one topic differ, so one EVID per review. evid: an existing EVID. Takes minutes: answers evid and state "running"; wait with fh_evmap_get_info, about every 30 seconds, until state is "done", then read with fh_evmap_get_map. Built once per EVID: a call on a finished map answers "done" and builds nothing; failed, interrupted or with sections not built (not_built in fh_evmap_get_info): call again with the same evid.`,
    {
      topic: z.string().optional().describe("The intervention and its goal, e.g. \"Telmisartan for Health & Longevity\". The goal decides what is picked: for health and longevity, prevention and long-term use before acute care."),
      evid: z.string().optional().describe("Instead of topic: an existing EVID with \"topic\" in its metadata — the intervention and its goal, as above."),
    },
    async ({ topic, evid: evidArg }) => {
      const answer = (o: object, isError = false) => ({ content: [{ type: "text" as const, text: compact(o) }], ...(isError ? { isError: true } : {}) });
      if (!topic === !evidArg) { log("evmap", evidArg ?? null, "error topic or evid, one of them"); return answer({ error: "give either topic (a new EVID) or evid, not both, not neither" }, true); }
      let evid = evidArg ?? "", name = topic?.trim() ?? "";
      if (topic) { const c = createEvid(FH_EVIDENCE_DIR, { topic: name }); if (!c.ok) return answer({ error: c.error }, true); evid = c.evid; log("evid", evid, `create topic=${name}`); }
      else {
        const o = openEvid(FH_EVIDENCE_DIR, evid);
        if (!o.ok) { log("evmap", evid, `error ${o.error}`); return answer({ error: o.error }, true); }
        evid = o.evid; name = typeof o.metadata.topic === "string" ? o.metadata.topic.trim() : "";
        if (!name) { log("evmap", evid, "error no topic in the metadata"); return answer({ error: `${evid} has no "topic" in its metadata` }, true); }
      }
      // The build is a job (src/mapjob.ts): the answer is the finished map's summary when it is done
      // within FH_EVMAP_WAIT_SECS, else "running" — fh_evmap_get_map then answers the state.
      if (jobRunning(evid)) { const j = readJob(FH_EVIDENCE_DIR, evid); return answer(j ? jobAnswer(evid, j) : { evid, state: "running" }); }
      // one map per EVID: a finished one is not built again
      const have = getAspects(FH_EVIDENCE_DIR, evid)?.sections;
      if (have && readJob(FH_EVIDENCE_DIR, evid)?.state === "done" && !notBuilt(FH_EVIDENCE_DIR, evid).length) { log("evmap", evid, "exists already"); return answer({ evid, state: "done", sections: have, note: "this EVID's map is built: fh_evmap_get_map" }); }
      // The server's own discovery (src/discovery.ts): it writes the queries, searches, screens and picks per item.
      const job = startJob(FH_EVIDENCE_DIR, evid, async (stage) => {
        const r = await discoverMap(FH_EVIDENCE_DIR, evid, name, process.env, liveDeps(process.env, (m) => { log("evmap", evid, `discovery ${m}`); stage(m); }));
        log("evmap", evid, r.ok ? `created ${r.discovery.survey.length + r.discovery.items.length} queries, ${r.included} articles, ${r.discovery.seconds} s` : `${r.failed ? "failed" : "error"} ${r.error}`);   // failed: the settings or a service
        if (!r.ok) return r;
        const p = r.discovery.picks;
        return { ok: true as const, evid: r.evid, included: r.included, sections: getAspects(FH_EVIDENCE_DIR, evid)?.sections, seconds: r.discovery.seconds };
      });
      const r = await Promise.race([job, new Promise<null>((res) => setTimeout(() => res(null), waitSecs() * 1000))]);
      if (!r) { const j = readJob(FH_EVIDENCE_DIR, evid); return answer(j ? jobAnswer(evid, j) : { evid, state: "running" }); }
      const { ok, ...rest } = r;
      return answer(rest, !ok);
    }
  );

  if (evidenceMapEnabled()) server.tool(
    "fh_evmap_get_info",
    "An EVID's evidence map in brief, no articles: its topic exactly as given to fh_evmap_create_map (compare it with yours before using a map), its state (running, done, failed, interrupted) and its counts. not_built: sections whose aspects could not be written — not the same as none found.",
    { evid: z.string().describe("The EVID.") },
    async ({ evid }) => {
      const answer = (o: object, isError = false) => ({ content: [{ type: "text" as const, text: compact(o) }], ...(isError ? { isError: true } : {}) });
      const o = openEvid(FH_EVIDENCE_DIR, evid);
      if (!o.ok) { log("evmap", evid, `error ${o.error}`); return answer({ error: o.error }, true); }
      const topic = typeof o.metadata.topic === "string" ? o.metadata.topic : "";
      const j = readJob(FH_EVIDENCE_DIR, o.evid), list = getAspects(FH_EVIDENCE_DIR, o.evid, { all: true });
      if (!topic || !(j || list)) { log("evmap", o.evid, "error no map"); return answer({ error: `${o.evid} has no evidence map` }, true); }
      log("evmap", o.evid, `info reported ${j?.state ?? "done"}`);
      if (j && j.state !== "done") return answer({ topic, state: j.state, stage: j.stage, seconds: j.seconds, ...(j.state === "failed" ? { error: j.error, next: "call fh_evmap_create_map again with this evid: what was searched and screened is kept" } : {}) });   // the call worked: "failed" is the state it reports
      const n = mapCounts(FH_EVIDENCE_DIR, o.evid);
      const nb = notBuilt(FH_EVIDENCE_DIR, o.evid);
      return answer({ topic, state: "done", built: j?.finished, seconds: j?.seconds, ...n, sections: list?.sections, ...(nb.length ? { not_built: nb, next: "call fh_evmap_create_map again with this evid: it writes the missing aspects, what was searched and screened is kept" } : {}) });
    }
  );

  if (evidenceMapEnabled()) server.tool(
    "fh_evmap_get_query_performance",
    "Not needed to use a map. How each query of an EVID's evidence map did, as rows in columns order: query, round, hits (PubMed), used (fewer than hits: cut off), kept (screening positive), unique (kept, found by no other query), picked (picked for an aspect).",
    { evid: z.string().describe("The EVID.") },
    async ({ evid }) => {
      const r = getQueryPerformance(FH_EVIDENCE_DIR, evid);
      log("evmap", evid, r.ok ? `performance reported ${r.rows.length} queries` : `error ${r.error}`);
      const { ok, ...rest } = r;
      return { content: [{ type: "text" as const, text: compact(rest) }], ...(ok ? {} : { isError: true }) };
    }
  );

  if (evidenceMapEnabled()) server.tool(
    "fh_evmap_report_gap",
    "You are about to add an article to the review that the map did not give you: call this first, with the article's pmid, the section it goes in and the aspect it backs; reason: one sentence. Every call is stored as a gap report, so no test calls. Answers instead: the map's aspects of that section that cover the aspect, with their PMIDs — one of them may back your claim already. class says what to do: picked — the map has the article under the aspect named, check your claim with fh_verify_claim; not picked — in the map but ranked out, add it if the claim needs it; screened off-topic — read its abstract before adding; not found — no query found it: check its design and your claim, then add it.",
    {
      evid: z.string().describe("The EVID."),
      pmid: z.string().describe("The article you would add, \"30955454\" or \"pmid:30955454\"."),
      aspect: z.string().describe("What the article backs, named as the map names its aspects, e.g. \"Levothyroxine\", \"Blood pressure\"."),
      section: z.string().describe(`The section the article goes in, by its exact name (case ignored): ${SECTIONS}.`),
      reason: z.string().optional().describe("What claim it is to back."),
    },
    async (a) => {
      const r = reportGap(FH_EVIDENCE_DIR, { evid: a.evid, pmid: a.pmid, item: a.aspect, kind: a.section.trim(), reason: a.reason });
      log("evmap", a.evid, r.ok ? `gap ${r.class} pmid:${a.pmid.replace(/^pmid:/i, "")} · ${a.section.trim()}: ${a.aspect}${a.reason ? ` · ${a.reason}` : ""}` : `error ${r.error}`);
      const { ok, ...rest } = r;
      return { content: [{ type: "text" as const, text: compact(rest) }], ...(ok ? {} : { isError: true }) };
    }
  );

  if (evidenceMapEnabled()) server.tool(
    "fh_evmap_get_gaps",
    "Not needed to use a map. What was reported with fh_evmap_report_gap in this library, newest first, as rows in columns order, and counts per class. Filters: since (YYYY-MM-DD), evid, class.",
    {
      since: z.string().optional().describe("Only reports from this date on, YYYY-MM-DD."),
      evid: z.string().optional().describe("Only this EVID's."),
      class: z.enum(["not found", "screened off-topic", "not picked", "picked"]).optional().describe("Only this class."),
      limit: z.number().int().positive().optional().describe("How many rows (default 100, at most 1000)."),
    },
    async (a) => {
      const r = getGaps(FH_EVIDENCE_DIR, a);
      log("evmap", a.evid ?? null, `gaps reported ${r.rows.length} of ${r.total}`);
      return { content: [{ type: "text" as const, text: compact(r) }] };
    }
  );

  if (evidenceMapEnabled()) server.tool(
    "fh_evmap_get_map",
    `An EVID's evidence map: for a section of the review you are writing, the articles not to overlook. A guide, not the answer: it is not complete, and an aspect says a topic was studied, not that an effect exists or in which direction; your own searches and your review's rules still decide. While it is built: state (running, failed, interrupted) — ask again later.
Without section: the map's sections and how many aspects each has (0: none found for it).
section (its exact name, case ignored): its aspects — what the intervention has been studied for there. An aspect row: id (a number that never changes), aspect (its name), pmids (the articles about it, the most important first). An article is about its aspect; whether it states your claim: fh_verify_claim. It may be an animal or in vitro study or a case report: check its design (fh_pubmed_fetch_articles) before using it. Sections: ${SECTIONS}.
What each article is — title, year, study design, participants, humans or animals: fh_pubmed_fetch_articles(pmids), up to 200 at once. Its abstract: fh_library_read(id, abstract_only: true).
PubMed articles only: what a drug label states (adverse reactions, interactions, contraindications) is not in the map — read the label (fh_dailymed_search_labels).`,
    {
      evid: z.string().describe("The EVID."),
      section: z.string().optional().describe("A section of the review, by its exact name as above (case ignored)."),
      id: z.coerce.number().int().positive().optional().describe("Instead of section: one aspect by its id."),
    },
    async ({ evid, section, id }) => {
      const answer = (o: object, isError = false) => ({ content: [{ type: "text" as const, text: compact(o) }], ...(isError ? { isError: true } : {}) });
      // a map still being built (or whose build failed or was interrupted): its state, not a half map
      const j = readJob(FH_EVIDENCE_DIR, evid);
      if (j && j.state !== "done") { log("evmap", evid, `map ${j.state} · ${j.stage}`); return answer(jobAnswer(evid, j), j.state === "failed"); }
      const m = getAspects(FH_EVIDENCE_DIR, evid, { section, id });
      if (!m) { log("evmap", evid, "error no map"); return answer({ error: `${evid} has no evidence map — build it: fh_evmap_create_map` }, true); }
      const names = m.sections.map((x) => x.section);
      if (id !== undefined && !m.aspects.length) { log("evmap", evid, `error no aspect ${id}`); return answer({ error: `no aspect ${id} in this map` }, true); }
      if (id === undefined && section && !names.some((n) => n.toLowerCase() === section.trim().toLowerCase())) { log("evmap", evid, `error no section ${section}`); return answer({ error: `no section "${section}" in this map — its sections: ${names.join(", ")}` }, true); }
      const nb = notBuilt(FH_EVIDENCE_DIR, evid);
      if (id === undefined && !section) { log("evmap", evid, `sections reported ${m.sections.length}`); return answer({ sections: m.sections, ...(nb.length ? { not_built: nb.map((x) => x.section) } : {}) }); }
      log("evmap", evid, `reported ${m.aspects.length} ${m.aspects.length === 1 ? "aspect" : "aspects"}, ${new Set(m.aspects.flatMap((a) => a.pmids)).size} articles · ${id ?? section}`);
      // one section: its name once, not on every aspect
      return answer(id !== undefined ? { aspects: m.aspects } : { section: names.find((n) => n.toLowerCase() === section!.trim().toLowerCase()), aspects: m.aspects.map(({ section: _s, ...a }) => a), ...(nb.some((x) => x.section.toLowerCase() === section!.trim().toLowerCase()) ? { note: NOT_BUILT } : m.aspects.length ? {} : { note: NO_ASPECT }) });
    }
  );

  server.tool(
    "fh_clinicaltrials_search_studies",
    `Search ClinicalTrials.gov by free text, intervention or condition — at least one of them; status ongoing | completed | all; sort relevance | newest | largest | completion. Returns the total and up to ${MAX_TRIALS} rows as arrays in columns order: NCT ID, title, status, phase, enrollment ("~100" estimated), start, primary completion, primary outcome, conditions, interventions, has_results. Link: https://clinicaltrials.gov/study/<NCT ID>. Cached ${searchCacheDays()} days. One trial in detail: fh_clinicaltrials_get_study_record.`,
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
      if (!r.ok) { log("search", "nct", `${r.input ? "error" : `failed ${secs}`} ${r.error}${((t) => t ? ` | ${t}` : "")([args.query, args.intervention, args.condition].map((v) => v?.trim()).filter(Boolean).join(" "))}`); return { content: [{ type: "text" as const, text: compact({ error: r.error }) }], isError: true }; }
      bump("search", r.cached);
      const q = r.result.query, parts = [q.intervention && `intervention=${q.intervention}`, q.condition && `condition=${q.condition}`, q.query && `query=${q.query}`].filter(Boolean).join(" ");
      log("search", "nct", `ok ${r.cached ? "cached" : secs} rows=${r.result.rows.length} total=${r.result.total} status=${q.status}${q.sort !== "relevance" ? ` sort=${q.sort}` : ""} | ${parts}`);
      return { content: [{ type: "text" as const, text: searchAnswer(r.result) }] };
    }
  );

  // fh_web_search(query, max_results?) — offered when a provider is configured
  // (FH_WEB_SEARCH_<PROVIDER>_API_KEY); src/websearch.ts.
  if (webSearchConfigured()) server.tool(
    "fh_web_search",
    `Search the web — use it instead of the built-in web search. It returns links (title, URL, date, author) with a short passage from each page, not the page text, so it costs a fraction of the context; read a result with fh_fetch_url. It finds more, especially within one site: restrict it with site: in the query, as with any search engine ("metformin site:nih.gov", several with "(site:nih.gov OR site:who.int)"), a restriction the built-in search often ignores. Each search returns all it finds; for more, search again with other words. Searches are cached locally for ${searchCacheDays()} days; a repeated search is answered in milliseconds.`,
    {
      query: z.string().describe('The query, site: terms included: "metformin site:nih.gov", "statin muscle pain".'),
      max_results: z.number().int().min(1).optional().describe("At most this many rows; unset: all the search finds."),
    },
    async (args) => {
      const t0 = Date.now();
      const r = await webSearch(args, FH_EVIDENCE_DIR, undefined, undefined, (line) => log("search", "web", `${line} | ${args.query}`));
      const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0") + "s";
      if (!r.ok) { log("search", "web", `${r.input ? "error" : `failed ${secs}`} ${r.error} | ${args.query}`); return { content: [{ type: "text" as const, text: compact({ error: r.error }) }], isError: true }; }
      bump("search", r.cached);
      const q = r.result.query;
      const per = Object.entries(r.result.providers).map(([n, v]) => `${n}=${typeof v === "number" ? v : "failed"}`).join(" ");   // a provider that failed: the others answered
      log("search", "web", `ok ${r.cached ? "cached" : secs} rows=${r.result.rows.length}${r.result.rows.length < r.result.total ? ` of ${r.result.total}` : ""} ${per} | ${q.query}${q.sites ? " " + q.sites.map((d) => `site:${d}`).join(" ") : ""}`);
      return { content: [{ type: "text" as const, text: searchAnswer({ total: r.result.total, columns: r.result.columns, rows: r.result.rows }) }] };
    }
  );

  // fh_dailymed_search_labels(drug_name, labeler?, max_results?) — FDA drug labels by
  // name: the set ID for dailymed:<set ID> in one call (src/dailymedsearch.ts).
  server.tool(
    "fh_dailymed_search_labels",
    `Find FDA drug labels on DailyMed by drug name, generic or brand: the total and up to ${MAX_LABELS} rows as arrays in columns order — set ID, title (drug and form), labeler (the company), published date, version, and the library level when the label is already stored. Newest first. A generic name lists every maker's label; labeler narrows to one company ("Boehringer" for Micardis's maker), a brand name to its own labels. Pass the set ID as "dailymed:<set ID>" to fh_library_read or fh_library_add. Use this, not DailyMed's search page: fetched as Markdown the page shows no set IDs, raw it is some 150,000 characters. The same search is answered from disk for ${searchCacheDays()} days.`,
    {
      drug_name: z.string().describe('Generic or brand name: "telmisartan", "Micardis".'),
      labeler: z.string().optional().describe("Part of the company's name, to narrow to its labels: \"Boehringer\"."),
      max_results: z.number().int().min(1).max(MAX_LABELS).default(20).describe("Rows to return (1–100)."),
    },
    async (args) => {
      const t0 = Date.now();
      const r = await searchLabels(args, FH_EVIDENCE_DIR);
      const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0") + "s";
      if (!r.ok) { log("search", "dailymed", `${r.input ? "error" : `failed ${secs}`} ${r.error}${args.drug_name?.trim() ? ` | ${args.drug_name.trim()}` : ""}`); return { content: [{ type: "text" as const, text: compact({ error: r.error }) }], isError: true }; }
      bump("search", r.cached);
      const q = r.result.query;
      log("search", "dailymed", `ok ${r.cached ? "cached" : secs} rows=${r.result.rows.length} total=${r.result.total} | ${q.drug_name}${q.labeler ? ` labeler=${q.labeler}` : ""}`);
      return { content: [{ type: "text" as const, text: searchAnswer(r.result) }] };
    }
  );

  // fh_clinicaltrials_get_study_record(nct) / _get_study_results(nct, max_chars?) — thin answers
  // over the stored nct: entry (added first when missing): the review's detail
  // of one trial, and its posted results (src/trialrecord.ts).
  const nctEntry = async (id: string): Promise<{ paths: EntryPaths; requested: string; added: boolean } | { error: string }> => {
    const p = parseId(/^\d{8}$/.test(id.trim()) ? `nct:${id.trim()}` : id);
    if (p.error) return { error: p.error };
    if (p.type !== "nct") return { error: `not a trial ID: ${p.requested}` };
    const paths = entryPaths(FH_EVIDENCE_DIR, p.type!, p.id!);
    const added = !entryExists(paths);
    if (added) { const r = await addEntry(p.requested); const s = JSON.parse(r.content[0].text) as Status; if (s.error) return { error: s.error }; }
    return { paths, requested: p.requested, added };
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
      // A time only when the trial was downloaded first: a stored record answers in milliseconds.
      log("trials", e.requested, `record ${e.added ? `${((Date.now() - t0) / 1000).toFixed(1).padStart(4, "0")}s ` : ""}${r.status ?? ""}${r.has_results ? " results" : ""} | ${r.title}`);
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
// Asked 2026-11-04 (AI4L audit, step 3): a review with 67 articles took about
// 3 minutes to add when every entry was cached, about 20 on first contact.
// Decided 2026-11-04: `fh_library_add` stays one ID per call, with no batch
// tool and no queue.
//
// * **The server does not serialise calls.** The MCP SDK runs each request
//   in its own handler; a log of 2026-11-04 shows twenty calls inside one
//   second. The minutes on a cached run are client round trips.
// * **No batch.** A batch has one response: on a first-contact article the
//   cascade can run minutes, and a client timeout would lose every status in
//   it. One call per ID keeps a timeout to one article and the log to one line
//   per call. The per-article status is what the model puts in its table.
// * **Built and reverted the same day:** an instant return for stored entries
//   with upkeep in the background, a single worker for missing articles, a
//   bounded wait with a `queued` level. Any parallel scheme needs a loop the
//   model must follow (it cannot know which articles are stored), and that
//   complexity was not wanted.
