import { bool, num, sourceOf, str, type Source } from "./env.js";
import { BUILTIN } from "./tiers/index.js";
import type { Tier } from "./tiers/tier.js";
import { urlTier } from "./tiers/url.js";

// Which tiers run, in which order, and the cascade's settings — all from the
// environment (src/env.ts: .env loaded first; environment, then .env, then the
// default). No configuration file.
//
//   FH_SOURCES=pmc,unpaywall,proxy   the full-text sources: exactly these, in
//       this order; a source not listed is off. Unset: the built-in order, every
//       tier on (and proxy last, when its URL is set).
//   FH_PROXY_URL=https://…/{doi}   the one proxy tier, named "proxy":
//       a URL template with {doi} {pmid} {pmcid}; unset = no proxy tier.
//   FH_PROXY_HEADERS=Name: value; Name: value   its request headers
//       (credentials), optional.
//   FH_ELSEVIER_API_KEY, FH_WILEY_TDM_TOKEN   the tdm tier's
//       tokens; FH_CORE_API_KEY the core tier's key (skipped without).
//   FH_RETRY_AFTER_DAYS (1)   cooldown before a transient tier failure
//       is retried.
//   FH_RETRY_BLOCKED (false)   a browser challenge not cleared or a
//       Bright Data refusal is final by default — the same method tomorrow ends
//       the same way; true treats them as transient (after a change of method).
//   FH_SEARCH_CACHE_DAYS (7)   days a registry or PubMed search
//       (fh_clinicaltrials_search_studies, fh_pubmed_search_articles)
//       is cached — answered from disk — before it is run again.
//   FH_REFRESH_AFTER_DAYS (30)   age of the stored PubMed record after
//       which fh_library_add re-reads it for correction notices and retractions.

// Every variable the server reads, for fh_info's provenance (which source
// each came from, never the value).
export const VARIABLES = [
  "FH_EVIDENCE_DIR", "FH_LOG_KEEP_DAYS", "FH_CLIENT_NAME", "FH_CLIENT_SHOW", "FH_ENV", "FH_SOURCES", "FH_CONTACT_EMAIL",
  "FH_ELSEVIER_API_KEY", "FH_WILEY_TDM_TOKEN", "FH_CORE_API_KEY",
  "FH_PROXY_URL", "FH_PROXY_HEADERS",
  "FH_FETCH_PROXY", "FH_PLAYWRIGHT_1", "FH_PLAYWRIGHT_2", "FH_CHROME_1", "FH_PLAYWRIGHT_HEADLESS",
  "FH_VERIFY_PROVIDER",
  "FH_VERIFY_PERPLEXITY_MODEL", "FH_VERIFY_PERPLEXITY_URL", "FH_VERIFY_PERPLEXITY_API_KEY",
  "FH_VERIFY_GOOGLE_MODEL", "FH_VERIFY_GOOGLE_URL", "FH_VERIFY_GOOGLE_API_KEY",
  "FH_VERIFY_OPENAI_MODEL", "FH_VERIFY_OPENAI_URL", "FH_VERIFY_OPENAI_API_KEY",
  "FH_VERIFY_LIQUID_MODEL", "FH_VERIFY_LIQUID_URL", "FH_VERIFY_LIQUID_API_KEY",
  "FH_VERIFY_MODEL", "FH_VERIFY_URL", "FH_VERIFY_API_KEY", "FH_VERIFY_THRESHOLD", "FH_VERIFY_TIMEOUT_SECS",
  "FH_RETRY_AFTER_DAYS", "FH_RETRY_BLOCKED", "FH_REFRESH_AFTER_DAYS", "FH_SEARCH_CACHE_DAYS",
  "FH_NCBI_API_KEY", "FH_WEB_SEARCH_EXA_API_KEY", "FH_WEB_SEARCH_SERPER_API_KEY", "FH_WEB_SEARCH_BRAVE_API_KEY", "FH_WEB_SEARCH_SNIPPETS", "FH_WEB_SEARCH_TIMEOUT_SECS", "FH_OPENALEX_API_KEY", "FH_ZENROWS_API_KEY", "FH_FIRECRAWL_API_KEY", "FH_ZYTE_API_KEY", "FH_BRIGHTDATA_API_KEY", "FH_BRIGHTDATA_ZONE", "FH_DATACITE_ENABLED", "FH_DATACITE_REPOSITORY_ID", "FH_DATACITE_PASSWORD", "FH_DATACITE_PREFIX", "FH_DATACITE_API_URL", "FH_DATACITE_SUFFIX_FORMAT", "FH_DATACITE_NAMESPACE", "FH_DATACITE_RESOLVER_URL", "FH_EVID_ENABLED", "FH_EVID_MAX_MB", "FH_EVMAP_ENABLED", "FH_EVMAP_MAX_RESULTS_PER_QUERY", "FH_EVMAP_CITATION_REVIEWS", "FH_EVMAP_CITATION_MAX_ADDED", "FH_EVMAP_RANKING_PROVIDER", "FH_EVMAP_RANKING_API_KEY", "FH_EVMAP_RANKING_MODEL", "FH_EVMAP_RANKING_URL", "FH_EVMAP_RANKING_ITEM_CANDIDATES", "FH_EVMAP_RANKING_ITEM_PICKS", "FH_EVMAP_RANKING_ASSIGN_ARTICLES", "FH_EVMAP_ASPECT_ARTICLES", "FH_EVMAP_SCREENING_PROVIDER", "FH_EVMAP_ANTHROPIC_API_KEY", "FH_EVMAP_ANTHROPIC_MODEL", "FH_EVMAP_ANTHROPIC_URL", "FH_EVMAP_GOOGLE_API_KEY", "FH_EVMAP_GOOGLE_MODEL", "FH_EVMAP_GOOGLE_URL", "FH_EVMAP_OPENAI_API_KEY", "FH_EVMAP_OPENAI_MODEL", "FH_EVMAP_OPENAI_URL", "FH_EVMAP_OPENROUTER_API_KEY", "FH_EVMAP_OPENROUTER_MODEL", "FH_EVMAP_OPENROUTER_URL", "FH_EVMAP_SCREENING_URL", "FH_EVMAP_SCREENING_API_KEY", "FH_EVMAP_SCREENING_MODEL", "FH_EVMAP_SCREENING_PARALLEL", "FH_EVMAP_PROMPTS", "FH_EVMAP_WAIT_SECS", "FH_EVMAP_DISCOVERY_PROVIDER", "FH_EVMAP_DISCOVERY_API_KEY", "FH_EVMAP_DISCOVERY_MODEL", "FH_EVMAP_DISCOVERY_URL", "FH_EVMAP_DISCOVERY_ITERATIONS", "FH_EVMAP_DISCOVERY_ITEM_RESULTS", "FH_EVMAP_DISCOVERY_SURVEY_RESULTS", "FH_EVMAP_DISCOVERY_TITLES", "FH_EVMAP_XAI_API_KEY", "FH_EVMAP_XAI_MODEL", "FH_EVMAP_XAI_URL",
] as const;
// Development-only features (EVID, the evidence map, DataCite) are not named at all while their switch is off.
const on = (v: string | undefined) => /^(true|1|yes|on)$/i.test(v?.trim() ?? "");
const hidden = (v: string, env: NodeJS.ProcessEnv) => (v.startsWith("FH_EVID_") && !on(env.FH_EVID_ENABLED)) || (v.startsWith("FH_DATACITE_") && !on(env.FH_DATACITE_ENABLED)) || (v.startsWith("FH_EVMAP_") && !on(env.FH_EVMAP_ENABLED));
export const sources = (env: NodeJS.ProcessEnv = process.env): Record<string, Source> => Object.fromEntries(VARIABLES.filter((v) => !hidden(v, env)).map((v) => [v, sourceOf(v, env)]));

export type Settings = { retry_after_days: number; retry_blocked: boolean; refresh_after_days: number; search_cache_days: number };
export function settings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    retry_after_days: num("FH_RETRY_AFTER_DAYS", 1, env),
    retry_blocked: bool("FH_RETRY_BLOCKED", false, env),
    refresh_after_days: num("FH_REFRESH_AFTER_DAYS", 30, env),
    search_cache_days: num("FH_SEARCH_CACHE_DAYS", 7, env),
  };
}

// "Authorization: Bearer x; X-Key: y" → { Authorization: "Bearer x", "X-Key": "y" }.
export function proxyHeaders(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const name = part.slice(0, i).trim(), value = part.slice(i + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

export type ResolvedTiers = {
  tiers: Tier[];                                   // enabled, in run order
  all: { name: string; enabled: boolean }[];       // the run order, then what is off
  source: Source;                                  // where FH_SOURCES came from
  problems: string[];
};

export function resolveTiers(env: NodeJS.ProcessEnv = process.env): ResolvedTiers {
  const problems: string[] = [];
  const available = new Map<string, Tier>();
  const tokens = { elsevier: str("FH_ELSEVIER_API_KEY", env) || undefined, wiley: str("FH_WILEY_TDM_TOKEN", env) || undefined };
  for (const t of BUILTIN) available.set(t.name, t.make({ tokens, api_key: str("FH_CORE_API_KEY", env) || undefined }));
  const proxyUrl = str("FH_PROXY_URL", env);
  if (proxyUrl) available.set("proxy", urlTier("proxy", proxyUrl, proxyHeaders(str("FH_PROXY_HEADERS", env))));

  const key = "FH_SOURCES";
  const listed = str(key, env);
  const order = listed ? listed.split(",").map((s) => s.trim()).filter(Boolean) : [...available.keys()];
  const tiers: Tier[] = [], seen = new Set<string>();
  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    const t = available.get(name);
    if (t) tiers.push(t);
    else if (name === "proxy") problems.push(`${key}: "proxy" listed, but FH_PROXY_URL is unset`);
    else problems.push(`${key}: unknown source "${name}" (built-in: ${BUILTIN.map((t) => t.name).join(", ")}; proxy when FH_PROXY_URL is set)`);
  }
  const all = [...tiers.map((t) => ({ name: t.name, enabled: true })), ...[...available.keys()].filter((n) => !seen.has(n)).map((name) => ({ name, enabled: false }))];
  return { tiers, all, source: sourceOf(key, env), problems };
}
