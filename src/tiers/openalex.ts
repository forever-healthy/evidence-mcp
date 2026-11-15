import { fetchText, LIBRARY_UA } from "../http.js";
import { contactEmail } from "../contact.js";
import { download } from "../download.js";
import { errMsg, looked, miss, oaVersion, type Candidate, type Paper, type RunContext, type Tier, type TierResult } from "./tier.js";

// openalex: second opinion on open-access copies, by PMID or DOI; often knows
// repository copies Unpaywall misses. Keyless; mailto joins the polite pool.
export const openalex: Tier = {
  name: "openalex",
  applies: (p: Paper) => (p.pmid || p.doi ? true : "no pmid or doi"),
  lookup: (p: Paper) => fetchText(`https://api.openalex.org/works/${encodeURIComponent(p.pmid ? `pmid:${p.pmid}` : `doi:${p.doi}`)}?mailto=${encodeURIComponent(contactEmail())}`, { "User-Agent": LIBRARY_UA }),
  async run(p: Paper, ctx: RunContext): Promise<TierResult> {
    let data: OpenAlexWork;
    try { data = JSON.parse(await looked(this, p, ctx)); } catch (e) { return miss(this.name, errMsg(e)); }
    const candidates = openalexCandidates(data);
    if (!candidates.length) return miss(this.name, data.open_access?.is_oa === false ? "closed" : "no oa copy");
    ctx.onTry?.(`located ${candidates.length} copies`);
    return download(this.name, p, candidates, ctx);
  },
};

export type OpenAlexLocation = { is_oa?: boolean; version?: string | null; pdf_url?: string | null; landing_page_url?: string | null; source?: { display_name?: string } | null };
export type OpenAlexWork = { open_access?: { is_oa?: boolean }; best_oa_location?: OpenAlexLocation | null; locations?: OpenAlexLocation[] };

export function openalexCandidates(d: OpenAlexWork): Candidate[] {
  const locs = [...(d.best_oa_location ? [d.best_oa_location] : []), ...(d.locations ?? [])].filter((l) => l.is_oa);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const l of locs) {
    for (const [url, pdf] of [[l.pdf_url, true], [l.landing_page_url, false]] as [string | null | undefined, boolean][]) {
      if (!url || seen.has(url) || /doi\.org\//.test(url)) continue;   // the DOI link is not a copy
      seen.add(url);
      out.push({ url, version: oaVersion(l.version), source: "openalex", host: l.source?.display_name ?? "unknown", pdf });
    }
  }
  return out;
}
