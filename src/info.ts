import { webSearchConfig, webSearchConfigured } from "./websearch.js";
import { browserStages, stageName, type BrowserStage, PLAYWRIGHT_VERSION } from "./browser.js";
import { fetchProxy, fetchProxyName, type FetchProxy } from "./fetchproxy.js";
import { unlockerConfigured, unlockers } from "./unlock.js";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./entry.js";
import { resolveTiers, settings, sources, type ResolvedTiers } from "./config.js";
import type { Source } from "./env.js";
import { isLocal, verifyConfig, verifyProblems } from "./verify/config.js";
import { evidenceMapEnabled } from "./evidencemap.js";
import { evidEnabled } from "./evid.js";
import { evmapModels, type EvmapModels } from "./rank.js";

// fh_info(): the configuration (libraryInfo) and the library's counts (libraryCounts) — entries by
// type, level, retraction and correction notices, from every <type>-<id>-meta.md. Reads only the
// frontmatter; entries written before corrections existed (no pubmed_checked line) are counted
// from their stored PubMed XML.
//
// The counts cost a walk over every entry (3 s on 20,000 entries with the files in memory, minutes
// when they come from disk — #104), so the walk never blocks the server (async), covers only the
// folders that hold entries (not the verify, search and screening caches), and its result is kept
// in <library>/.counts.json for every server on the library: fh_info answers from that file and
// has it counted again in the background once it is COUNTS_MAX_AGE_MS old.

export type Info = {
  evidence_dir: string;
  host: string;
  tiers: { name: string; enabled: boolean }[];   // run order first, then what is off
  // The configuration: the cascade's settings, problems with FH_SOURCES,
  // and per variable where its value came from (environment / .env / default) —
  // never the value.
  config: { retry_after_days: number; retry_blocked: boolean; refresh_after_days: number; search_cache_days: number; problems: string[]; sources: Record<string, Source> };
  download: { fetch: boolean; fetch_proxy: FetchProxy | null; playwright: { version: string; servers: BrowserStage[] }; chrome: BrowserStage[]; unlocker: boolean };   // playwright.version: what every Playwright server must run  // playwright: the version the package pins — a ws:// browser server must run the same
  // fh_verify_claim's decision model; null: the tool answers error. ok, ms and
  // error come from one tiny request when fh_info is called.
  verify: { provider: string; model: string; base_url: string; local: boolean; ok?: boolean; ms?: number; error?: string | null } | null;
  evid?: { entries: number; evidence_maps: number };   // only when FH_EVID_ENABLED: the EVIDs, and how many hold an evidence map
  evidence_map?: EvmapModels;   // only when FH_EVMAP_ENABLED: the screening and ranking models
  web_search?: string[];   // the providers behind fh_web_search (every one with a key); absent: no provider key, the tool is not offered
  unlockers: { provider: string; ok?: boolean; ms?: number; error?: string | null }[];
  stages: { name: string; host: string; port: number; up?: boolean; ms?: number; error?: string | null }[];   // our own stage hosts (fetch proxy, Playwright, Chrome) and whether each answers (filled by fh_info)   // the last download stages in the order tried, and whether each answers (filled by fh_info)
};

// The library's counts, and when they were taken.
export type Counts = {
  counted: string;     // ISO time the walk ended
  entries: number;
  size_bytes: number;  // the entries' files on disk
  size: string;        // the same, readable: "1.9 GiB"
  by_type: Record<string, number>;
  by_level: Record<string, number>;   // full_text, abstract, title (neither full text nor abstract text) — as the status reports level
  // Per entry type, what the TUI's status rows show: pmid and doi papers with
  // their levels and retractions, dailymed labels and nct records by count.
  types: Record<string, { entries: number; full_text: number; abstract: number; title: number; retracted: number; fulltext_not_tried?: number }>;   // fulltext_not_tried: stored from PubMed alone, the next read fetches it
  retracted: number;
  not_citable: number; // retracted, or title only — nothing to read
  errata: number;      // entries with an erratum_in notice
  concerns: number;    // entries with an expression_of_concern_in notice
  updates: number;     // entries with an update_in notice (superseded by a newer version)
};

// The folders that hold entries (<type>/<l1>/<l2>/<id>/, src/layout.ts); everything else in the library is a cache or a log.
export const ENTRY_TYPES = ["pmid", "doi", "dailymed", "nct", "url"];

const human = (n: number): string => { const u = ["B", "KiB", "MiB", "GiB", "TiB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return i ? `${n.toFixed(1)} ${u[i]}` : `${n} B`; };

function field(md: string, key: string): string {
  const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(md);
  return m ? m[1].trim() : "";
}

// EVIDs (evid/<2>/<4>/<16 hex>/) and how many hold an evidence map (evmap/evmap.db) — as the TUI counts them.
function evidCounts(lib: string): { entries: number; evidence_maps: number } {
  const dirs = (p: string) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(p, d.name)); } catch { return []; } };
  const all = dirs(join(lib, "evid")).flatMap(dirs).flatMap(dirs);
  return { entries: all.length, evidence_maps: all.filter((d) => existsSync(join(d, "evmap", "evmap.db"))).length };
}

export function libraryInfo(libraryDir: string, host: string, tiers: ResolvedTiers = resolveTiers()): Info {
  const info: Info = {
    evidence_dir: libraryDir, host,
    tiers: tiers.all, config: { ...settings(), problems: [...tiers.problems, ...verifyProblems(), ...(evidenceMapEnabled() ? evmapModels().problems : [])], sources: sources() },
    download: downloadInfo(),
    verify: verifyInfo(),
    ...(evidEnabled() ? { evid: evidCounts(libraryDir) } : {}),
    ...(evidenceMapEnabled() ? { evidence_map: evmapModels().models } : {}),
    ...(webSearchConfigured() ? { web_search: webSearchConfig().map((c) => c.provider) } : {}),
    unlockers: unlockers().map((provider) => ({ provider })),
    stages: ownStages(),
  };
  return info;
}

// One walk over every entry, without blocking the server: the folders of one type in turn,
// WALKERS second-level folders at once.
const WALKERS = 8;
export async function countLibrary(libraryDir: string): Promise<Counts> {
  const c: Counts = { counted: "", entries: 0, size_bytes: 0, size: "", by_type: {}, by_level: {}, types: {}, retracted: 0, not_citable: 0, errata: 0, concerns: 0, updates: 0 };
  const dirs = async (p: string) => { try { return (await readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(p, d.name)); } catch { return []; } };
  const entry = async (type: string, dir: string) => {
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    let bytes = 0;
    for (const f of names) { try { const st = await stat(join(dir, f)); if (st.isFile()) bytes += st.size; } catch { /* gone meanwhile */ } }
    for (const name of names) {
      if (!name.endsWith("-meta.md")) continue;
      let md: string;
      try { md = await readFile(join(dir, name), "utf8"); } catch { continue; }
      const raw = field(md, "level") || "unknown";
      const level = raw === "abstract" && field(md, "has_abstract") === "no" ? "title" : raw;
      c.entries++;
      c.by_type[type] = (c.by_type[type] ?? 0) + 1;
      c.by_level[level] = (c.by_level[level] ?? 0) + 1;
      const t = (c.types[type] ??= { entries: 0, full_text: 0, abstract: 0, title: 0, retracted: 0 });
      t.entries++;
      if (level === "full_text" || level === "abstract" || level === "title") t[level]++;
      if (raw === "abstract" && /^attempts:[ \t]*$/m.test(md)) t.fulltext_not_tried = (t.fulltext_not_tried ?? 0) + 1;
      c.size_bytes += bytes;
      const types = await noticeTypes(md, join(dir, name));
      if (field(md, "retracted") === "yes" || types.has("retraction_in") || types.has("partial_retraction_in") || types.has("retracted_and_republished_in")) { c.retracted++; c.not_citable++; t.retracted++; }
      else if (level === "title") c.not_citable++;
      if (types.has("erratum_in")) c.errata++;
      if (types.has("expression_of_concern_in")) c.concerns++;
      if (types.has("update_in")) c.updates++;
    }
  };
  for (const type of ENTRY_TYPES) {
    const l2: string[] = [];
    for (const l1 of await dirs(join(libraryDir, type))) l2.push(...await dirs(l1));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(WALKERS, l2.length) }, async () => {
      while (next < l2.length) { const d = l2[next++]; for (const e of await dirs(d)) await entry(type, e); }
    }));
  }
  c.size = human(c.size_bytes);
  c.counted = new Date().toISOString();
  return c;
}

// The counts for fh_info, from <library>/.counts.json. Younger than maxAgeMs: as they are. Older:
// as they are, and a count starts in the background. None yet: a count starts and is waited for
// up to waitMs; null when it takes longer (the next call has them). One count at a time for all
// servers on the library: .counts.lock, taken over when older than LOCK_STALE_MS.
export const COUNTS_MAX_AGE_MS = 10 * 60_000;
const LOCK_STALE_MS = 30 * 60_000;
const countsFile = (lib: string) => join(lib, ".counts.json");
export function readCounts(libraryDir: string): Counts | null {
  try { const c = JSON.parse(readFileSync(countsFile(libraryDir), "utf8")) as Counts; return typeof c.counted === "string" && typeof c.entries === "number" ? c : null; } catch { return null; }
}
const counting = new Map<string, Promise<Counts | null>>();   // this process's running count, per library
export function refreshCounts(libraryDir: string): Promise<Counts | null> {
  const running = counting.get(libraryDir);
  if (running) return running;
  if (!existsSync(libraryDir)) return Promise.resolve(null);
  const lock = join(libraryDir, ".counts.lock");
  try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); } catch { /* no lock */ }
  try { writeFileSync(lock, `${process.pid}\n`, { flag: "wx" }); } catch { return Promise.resolve(null); }   // another server is counting
  const p = countLibrary(libraryDir)
    .then((c) => { writeAtomic(countsFile(libraryDir), JSON.stringify(c) + "\n"); return c; })
    .catch(() => null)
    .finally(() => { counting.delete(libraryDir); try { unlinkSync(lock); } catch { /* gone */ } });
  counting.set(libraryDir, p);
  return p;
}
export async function libraryCounts(libraryDir: string, maxAgeMs = COUNTS_MAX_AGE_MS, waitMs = 20_000): Promise<Counts | null> {
  const have = readCounts(libraryDir);
  if (have && Date.now() - Date.parse(have.counted) < maxAgeMs) return have;
  const fresh = refreshCounts(libraryDir);
  if (have) { void fresh; return have; }
  // none yet: ours, or the one another server is taking — whichever is there within waitMs
  const t0 = Date.now();
  let done: Counts | null = null;
  void fresh.then((c) => { done = c; });
  while (Date.now() - t0 < waitMs) {
    if (done) return done;
    const c = readCounts(libraryDir);
    if (c) return c;
    await new Promise((r) => setTimeout(r, Math.min(250, waitMs)));
  }
  return done ?? readCounts(libraryDir);
}

// The notice types of one entry: from its corrections lines, or — for an
// entry written before they existed — from the RefTypes in its stored XML.
const XML_TYPES: Record<string, string> = { ErratumIn: "erratum_in", RetractionIn: "retraction_in", PartialRetractionIn: "partial_retraction_in", RetractedandRepublishedIn: "retracted_and_republished_in", ExpressionOfConcernIn: "expression_of_concern_in", UpdateIn: "update_in" };
async function noticeTypes(md: string, metaPath: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (/^pubmed_checked:/m.test(md)) {
    for (const m of md.matchAll(/^corrections:\s*(\S+)/gm)) out.add(m[1]);
    return out;
  }
  try {
    const xml = await readFile(metaPath.replace(/-meta\.md$/, "-abstract.xml"), "utf8");
    for (const m of xml.matchAll(/<CommentsCorrections RefType="([A-Za-z]+)"/g)) if (XML_TYPES[m[1]]) out.add(XML_TYPES[m[1]]);
  } catch { /* no XML: nothing to count */ }
  return out;
}

// The decision model fh_verify_claim sends paper text to; `local` false means
// the text leaves the machine.
// Our own stage hosts, in cascade order: the fetch proxy, then the browsers.
export function ownStages(): Info["stages"] {
  const f = fetchProxy();
  return [...(f ? [{ name: fetchProxyName(f), host: f.host, port: f.port }] : []), ...browserStages().map((b) => ({ name: stageName(b), host: b.host, port: b.port }))];
}

function verifyInfo(): Info["verify"] {
  const v = verifyConfig();
  return v ? { provider: v.provider.name, model: v.model, base_url: v.base_url, local: isLocal(v.base_url) } : null;
}

// The multi-stage fetch as resolved on this host: the fetch proxy, the browser stages in order (a
// local Chromium gets an install note when missing) and whether the unlocker
// has a token.
function downloadInfo() {
  const stages = browserStages();
  return { fetch: true, fetch_proxy: fetchProxy(), playwright: { version: PLAYWRIGHT_VERSION, servers: stages.filter((b) => b.kind === "playwright") }, chrome: stages.filter((b) => b.kind === "chrome"), unlocker: unlockerConfigured() };
}
