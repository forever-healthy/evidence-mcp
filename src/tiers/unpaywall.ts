import { fetchText, LIBRARY_UA } from "../http.js";
import { contactEmail } from "../contact.js";
import { download } from "../download.js";
import { errMsg, looked, miss, oaVersion, type Candidate, type Paper, type RunContext, type Tier, type TierResult } from "./tier.js";

// unpaywall: locates open-access copies of a DOI (publisher and repository),
// best copy first. Keyless; the contact email joins the polite pool.
export const unpaywall: Tier = {
  name: "unpaywall",
  applies: (p: Paper) => (p.doi ? true : "no doi"),
  lookup: (p: Paper) => fetchText(`https://api.unpaywall.org/v2/${encodeURIComponent(p.doi!)}?email=${encodeURIComponent(contactEmail())}`, { "User-Agent": LIBRARY_UA }),
  async run(p: Paper, ctx: RunContext): Promise<TierResult> {
    let data: UnpaywallResponse;
    try { data = JSON.parse(await looked(this, p, ctx)); } catch (e) { return miss(this.name, errMsg(e)); }
    const candidates = unpaywallCandidates(data);
    if (!candidates.length) return miss(this.name, data.is_oa === false ? "closed" : "no oa copy");
    ctx.onTry?.(`located ${candidates.length} copies`);
    return download(this.name, p, candidates, ctx);
  },
};

export type UnpaywallLocation = { url?: string | null; url_for_pdf?: string | null; url_for_landing_page?: string | null; version?: string | null; host_type?: string | null; is_best?: boolean };
export type UnpaywallResponse = { is_oa?: boolean; oa_status?: string; best_oa_location?: UnpaywallLocation | null; oa_locations?: UnpaywallLocation[] };

export function unpaywallCandidates(d: UnpaywallResponse): Candidate[] {
  const locs = [...(d.best_oa_location ? [d.best_oa_location] : []), ...(d.oa_locations ?? [])];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const l of locs) {
    for (const [url, pdf] of [[l.url_for_pdf, true], [l.url ?? l.url_for_landing_page, false]] as [string | null | undefined, boolean][]) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, version: oaVersion(l.version), source: "unpaywall", host: l.host_type ?? "unknown", pdf });
    }
  }
  return out;
}
