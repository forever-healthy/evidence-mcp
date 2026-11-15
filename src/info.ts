import { browserStages, stageName, type BrowserStage, PLAYWRIGHT_VERSION } from "./browser.js";
import { fetchProxy, fetchProxyName, type FetchProxy } from "./fetchproxy.js";
import { unlockerConfigured, unlockers } from "./unlock.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveTiers, settings, sources, type ResolvedTiers } from "./config.js";
import type { Source } from "./env.js";
import { isLocal, verifyConfig, verifyProblems } from "./verify/config.js";

// Library-wide summary for fh_info(): walks every <type>-<id>-meta.md and
// counts entries by type, level, retraction and correction notices. Reads only
// the frontmatter; entries written before corrections existed (no
// pubmed_checked line) are counted from their stored PubMed XML.

export type Info = {
  evidence_dir: string;
  host: string;
  tiers: { name: string; enabled: boolean }[];   // run order first, then what is off
  // The configuration: the cascade's settings, problems with FH_TIERS,
  // and per variable where its value came from (environment / .env / default) —
  // never the value.
  config: { retry_after_days: number; retry_blocked: boolean; refresh_after_days: number; search_cache_days: number; problems: string[]; sources: Record<string, Source> };
  download: { fetch: boolean; fetch_proxy: FetchProxy | null; playwright: { version: string; servers: BrowserStage[] }; chrome: BrowserStage[]; unlocker: boolean };   // playwright.version: what every Playwright server must run  // playwright: the version the package pins — a ws:// browser server must run the same
  // fh_verify_claim's decision model; null: the tool answers error. ok, ms and
  // error come from one tiny request when fh_info is called.
  verify: { provider: string; model: string; base_url: string; local: boolean; ok?: boolean; ms?: number; error?: string | null } | null;
  unlockers: { provider: string; ok?: boolean; ms?: number; error?: string | null }[];
  stages: { name: string; host: string; port: number; up?: boolean; ms?: number; error?: string | null }[];   // our own stage hosts (fetch proxy, Playwright, Chrome) and whether each answers (filled by fh_info)   // the last download stages in the order tried, and whether each answers (filled by fh_info)
  entries: number;
  size_bytes: number;  // the entries' files on disk
  size: string;        // the same, readable: "1.9 GiB"
  by_type: Record<string, number>;
  by_level: Record<string, number>;   // full_text, abstract, title (neither full text nor abstract text) — as the status reports level
  // Per entry type, what the TUI's status rows show: pmid and doi papers with
  // their levels and retractions, dailymed labels and nct records by count.
  types: Record<string, { entries: number; full_text: number; abstract: number; title: number; retracted: number }>;
  retracted: number;
  not_citable: number; // retracted, or title only — nothing to read
  errata: number;      // entries with an erratum_in notice
  concerns: number;    // entries with an expression_of_concern_in notice
  updates: number;     // entries with an update_in notice (superseded by a newer version)
};

function* metaFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* metaFiles(p);
    else if (name.endsWith("-meta.md")) yield p;
  }
}

const human = (n: number): string => { const u = ["B", "KiB", "MiB", "GiB", "TiB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return i ? `${n.toFixed(1)} ${u[i]}` : `${n} B`; };

function field(md: string, key: string): string {
  const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(md);
  return m ? m[1].trim() : "";
}

export function libraryInfo(libraryDir: string, host: string, tiers: ResolvedTiers = resolveTiers()): Info {
  const info: Info = {
    evidence_dir: libraryDir, host,
    tiers: tiers.all, config: { ...settings(), problems: [...tiers.problems, ...verifyProblems()], sources: sources() },
    download: downloadInfo(),
    verify: verifyInfo(),
    unlockers: unlockers().map((provider) => ({ provider })),
    stages: ownStages(),
    entries: 0, size_bytes: 0, size: "", by_type: {}, by_level: {}, types: {}, retracted: 0, not_citable: 0, errata: 0, concerns: 0, updates: 0,
  };
  for (const type of existsSync(libraryDir) ? readdirSync(libraryDir) : []) {
    const typeDir = join(libraryDir, type);
    if (!statSync(typeDir).isDirectory()) continue;
    for (const meta of metaFiles(typeDir)) {
      const md = readFileSync(meta, "utf8");
      const raw = field(md, "level") || "unknown";
      const level = raw === "abstract" && field(md, "has_abstract") === "no" ? "title" : raw;
      info.entries++;
      info.by_type[type] = (info.by_type[type] ?? 0) + 1;
      info.by_level[level] = (info.by_level[level] ?? 0) + 1;
      const t = (info.types[type] ??= { entries: 0, full_text: 0, abstract: 0, title: 0, retracted: 0 });
      t.entries++;
      if (level === "full_text" || level === "abstract" || level === "title") t[level]++;
      const dir = dirname(meta);
      for (const f of readdirSync(dir)) { try { const st = statSync(join(dir, f)); if (st.isFile()) info.size_bytes += st.size; } catch { /* gone meanwhile */ } }
      const types = noticeTypes(md, meta);
      if (field(md, "retracted") === "yes" || types.has("retraction_in") || types.has("partial_retraction_in") || types.has("retracted_and_republished_in")) { info.retracted++; info.not_citable++; t.retracted++; }
      else if (level === "title") info.not_citable++;
      if (types.has("erratum_in")) info.errata++;
      if (types.has("expression_of_concern_in")) info.concerns++;
      if (types.has("update_in")) info.updates++;
    }
  }
  info.size = human(info.size_bytes);
  return info;
}

// The notice types of one entry: from its corrections lines, or — for an
// entry written before they existed — from the RefTypes in its stored XML.
const XML_TYPES: Record<string, string> = { ErratumIn: "erratum_in", RetractionIn: "retraction_in", PartialRetractionIn: "partial_retraction_in", RetractedandRepublishedIn: "retracted_and_republished_in", ExpressionOfConcernIn: "expression_of_concern_in", UpdateIn: "update_in" };
function noticeTypes(md: string, metaPath: string): Set<string> {
  const out = new Set<string>();
  if (/^pubmed_checked:/m.test(md)) {
    for (const m of md.matchAll(/^corrections:\s*(\S+)/gm)) out.add(m[1]);
    return out;
  }
  try {
    const xml = readFileSync(metaPath.replace(/-meta\.md$/, "-abstract.xml"), "utf8");
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
