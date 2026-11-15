import { httpReason, LIBRARY_UA } from "../http.js";
import { download } from "../download.js";
import { errMsg, miss, type Candidate, type Paper, type RunContext, type Tier, type TierResult } from "./tier.js";

// core: CORE (core.ac.uk), the aggregator of open-access repository copies,
// queried by DOI. Needs a free API key (https://core.ac.uk/services/api);
// without one the tier is skipped. Config: { "name": "core", "api_key": "${CORE_API_KEY}" }
//
// Rate limit: a key allows 10 requests per minute (x-ratelimit-limit). Calls
// are paced to that per process, and a 429 is waited out once
// (x-ratelimit-retry-after) — several workers on one key share the window.
const WINDOW_MS = 60_000, PER_WINDOW = 10, MAX_WAIT_MS = 65_000, TIMEOUT_MS = 10_000;   // CORE answers in about a second or not at all
const calls: number[] = [];

async function pace(): Promise<void> {
  const now = Date.now();
  while (calls.length && calls[0] <= now - WINDOW_MS) calls.shift();
  if (calls.length >= PER_WINDOW) await new Promise((r) => setTimeout(r, calls[0] + WINDOW_MS - now + 200));
  calls.push(Date.now());
}

// GET with the key, paced; on 429 wait for the window to reset and retry once.
export async function coreFetch(url: string, key: string): Promise<string> {
  const headers = { "User-Agent": LIBRARY_UA, Authorization: `Bearer ${key}` };
  for (let attempt = 0; attempt < 2; attempt++) {
    await pace();
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    if (res.ok) return await res.text();
    const body = await res.text().catch(() => "");
    if (res.status === 429 && attempt === 0) {
      const until = Date.parse(res.headers.get("x-ratelimit-retry-after") ?? "");
      const wait = Number.isFinite(until) ? Math.min(Math.max(until - Date.now(), 1000), MAX_WAIT_MS) : 10_000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(res.status < 500 ? httpReason(res.status, body) : `HTTP ${res.status}`);
  }
  throw new Error("HTTP 429");
}
export function coreTier(apiKey?: string): Tier {
  const key = apiKey?.trim();
  return {
    name: "core",
    applies: (p: Paper) => (p.doi ? true : "no doi"),
    async run(p: Paper, ctx: RunContext): Promise<TierResult> {
      if (!key) return { ...miss(this.name, "needs api key"), skipped: true };
      let data: CoreSearchResponse;
      try {
        const q = encodeURIComponent(`doi:"${p.doi}"`);
        data = JSON.parse(await coreFetch(`https://api.core.ac.uk/v3/search/works/?q=${q}&limit=5`, key));
      } catch (e) { return miss(this.name, errMsg(e)); }
      const candidates = coreCandidates(data);
      if (!candidates.length) return miss(this.name, data.results?.length ? "no full text" : "not in core");
      ctx.onTry?.(`located ${candidates.length} copies`);
      return download(this.name, p, candidates, ctx);
    },
  };
}

export type CoreWork = { downloadUrl?: string | null; sourceFulltextUrls?: string[] | null; links?: { type?: string; url?: string }[] | null; documentType?: string | null };
export type CoreSearchResponse = { totalHits?: number; results?: CoreWork[] };

// CORE's own copy (downloadUrl, a PDF on core.ac.uk) first, then the
// repositories' full-text URLs. Version unknown to CORE; recorded as published.
export function coreCandidates(d: CoreSearchResponse): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (url: string | null | undefined, pdf: boolean, host: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, version: "published", source: "core", host, pdf });
  };
  for (const w of d.results ?? []) {
    add(w.downloadUrl, true, "core");
    for (const l of w.links ?? []) if (l.type === "download") add(l.url, /\.pdf($|\?)/i.test(l.url ?? ""), "core");
    for (const u of w.sourceFulltextUrls ?? []) add(u, /\.pdf($|\?)/i.test(u), "repository");
  }
  return out;
}
