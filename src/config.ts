import { bool, num, sourceOf, str, type Source } from "./env.js";
import { BUILTIN } from "./tiers/index.js";
import type { Tier } from "./tiers/tier.js";
import { urlTier } from "./tiers/url.js";

// Which tiers run, in which order, and the cascade's settings — all from the
// environment (src/env.ts: .env loaded first; environment, then .env, then the
// default). No configuration file.
//
//   FH_TIERS=pmc,unpaywall,proxy   the whole sequence: exactly these, in
//       this order; a tier not listed is off. Unset: the built-in order, every
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
  "FH_EVIDENCE_DIR", "FH_LOG_KEEP_DAYS", "FH_ENV", "FH_TIERS", "FH_CONTACT_EMAIL",
  "FH_ELSEVIER_API_KEY", "FH_WILEY_TDM_TOKEN", "FH_CORE_API_KEY",
  "FH_PROXY_URL", "FH_PROXY_HEADERS",
  "FH_FETCH_PROXY", "FH_PLAYWRIGHT_1", "FH_PLAYWRIGHT_2", "FH_CHROME_1", "FH_PLAYWRIGHT_HEADLESS",
  "FH_VERIFY_PROVIDER",
  "FH_VERIFY_PERPLEXITY_MODEL", "FH_VERIFY_PERPLEXITY_URL", "FH_VERIFY_PERPLEXITY_API_KEY",
  "FH_VERIFY_GOOGLE_MODEL", "FH_VERIFY_GOOGLE_URL", "FH_VERIFY_GOOGLE_API_KEY",
  "FH_VERIFY_OPENAI_MODEL", "FH_VERIFY_OPENAI_URL", "FH_VERIFY_OPENAI_API_KEY",
  "FH_VERIFY_MODEL", "FH_VERIFY_URL", "FH_VERIFY_API_KEY", "FH_VERIFY_THRESHOLD", "FH_VERIFY_TIMEOUT_SECS",
  "FH_RETRY_AFTER_DAYS", "FH_RETRY_BLOCKED", "FH_REFRESH_AFTER_DAYS", "FH_SEARCH_CACHE_DAYS",
  "FH_NCBI_API_KEY", "FH_ZENROWS_API_KEY", "FH_ZYTE_API_KEY", "FH_BRIGHTDATA_API_KEY", "FH_BRIGHTDATA_ZONE",
] as const;
export const sources = (env: NodeJS.ProcessEnv = process.env): Record<string, Source> => Object.fromEntries(VARIABLES.map((v) => [v, sourceOf(v, env)]));

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
  source: Source;                                  // where FH_TIERS came from
  problems: string[];
};

export function resolveTiers(env: NodeJS.ProcessEnv = process.env): ResolvedTiers {
  const problems: string[] = [];
  const available = new Map<string, Tier>();
  const tokens = { elsevier: str("FH_ELSEVIER_API_KEY", env) || undefined, wiley: str("FH_WILEY_TDM_TOKEN", env) || undefined };
  for (const t of BUILTIN) available.set(t.name, t.make({ tokens, api_key: str("FH_CORE_API_KEY", env) || undefined }));
  const proxyUrl = str("FH_PROXY_URL", env);
  if (proxyUrl) available.set("proxy", urlTier("proxy", proxyUrl, proxyHeaders(str("FH_PROXY_HEADERS", env))));

  const listed = str("FH_TIERS", env);
  const order = listed ? listed.split(",").map((s) => s.trim()).filter(Boolean) : [...available.keys()];
  const tiers: Tier[] = [], seen = new Set<string>();
  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    const t = available.get(name);
    if (t) tiers.push(t);
    else if (name === "proxy") problems.push('FH_TIERS: "proxy" listed, but FH_PROXY_URL is unset');
    else problems.push(`FH_TIERS: unknown tier "${name}" (built-in: ${BUILTIN.map((t) => t.name).join(", ")}; proxy when FH_PROXY_URL is set)`);
  }
  const all = [...tiers.map((t) => ({ name: t.name, enabled: true })), ...[...available.keys()].filter((n) => !seen.has(n)).map((name) => ({ name, enabled: false }))];
  return { tiers, all, source: sourceOf("FH_TIERS", env), problems };
}
