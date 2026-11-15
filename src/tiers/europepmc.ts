import { fetchText, LIBRARY_UA } from "../http.js";
import { download } from "../download.js";
import { errMsg, looked, miss, type Candidate, type Paper, type RunContext, type Tier, type TierResult } from "./tier.js";

// europepmc: Europe PMC's record for the PMID — its own full text (JATS XML
// for the open-access subset, the rendered PDF for everything it holds,
// author manuscripts included) and the free full-text links it lists from
// publishers and repositories. Keyless.
//   https://europepmc.org/RestfulWebService
export const europepmc: Tier = {
  name: "europepmc",
  applies: (p: Paper) => (p.pmid ? true : "no pmid"),
  lookup: (p: Paper) => fetchText(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`EXT_ID:${p.pmid} AND SRC:MED`)}&resultType=core&format=json`, { "User-Agent": LIBRARY_UA }),
  async run(p: Paper, ctx: RunContext): Promise<TierResult> {
    let data: EuropePmcResponse;
    try { data = JSON.parse(await looked(this, p, ctx)); } catch (e) { return miss(this.name, errMsg(e)); }
    const rec = data.resultList?.result?.[0];
    if (!rec) return miss(this.name, "not in europe pmc");
    const candidates = europepmcCandidates(rec, p.pmcid);
    if (!candidates.length) return miss(this.name, "no free copy");
    ctx.onTry?.(`located ${candidates.length} copies`);
    return download(this.name, p, candidates, ctx);
  },
};

export type EuropePmcUrl = { availabilityCode?: string; documentStyle?: string; site?: string; url?: string };
export type EuropePmcRecord = { pmcid?: string; isOpenAccess?: string; inEPMC?: string; hasPDF?: string; fullTextUrlList?: { fullTextUrl?: EuropePmcUrl[] } };
export type EuropePmcResponse = { resultList?: { result?: EuropePmcRecord[] } };

// Europe PMC's own copies first (XML, then the rendered PDF), then the free
// links it lists; "Subscription required" links and bare DOIs are not copies.
export function europepmcCandidates(r: EuropePmcRecord, pmcid: string | null | undefined): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (url: string, pdf: boolean, host: string, version: Candidate["version"]) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, version, source: "europepmc", host, pdf });
  };
  const id = (r.pmcid ?? pmcid ?? "").toUpperCase() || null;
  // Europe PMC's own copies: isOpenAccess N with the article in Europe PMC is
  // an author manuscript; the rendered PDF exists only where hasPDF says so.
  const own: Candidate["version"] = r.isOpenAccess === "Y" ? "published" : "accepted_manuscript";
  if (id && r.inEPMC === "Y") {
    if (r.isOpenAccess === "Y") add(`https://www.ebi.ac.uk/europepmc/webservices/rest/${id}/fullTextXML`, false, "europepmc", own);
    if (r.hasPDF === "Y") add(`https://europepmc.org/articles/${id}?pdf=render`, true, "europepmc", own);
  }
  // The free links it lists (publishers, repositories): version not stated.
  for (const u of r.fullTextUrlList?.fullTextUrl ?? []) {
    if (!u.url || u.site === "DOI" || !/^(F|OA)$/.test(u.availabilityCode ?? "")) continue;
    if (u.documentStyle === "abs") continue;   // a free ABSTRACT page (e.g. content.nejm.org/cgi/content/abstract/…) is not a full text
    if (/^https?:\/\/europepmc\.org\/articles\//i.test(u.url) && u.documentStyle === "html") continue;   // the article page is script-rendered; the PDF above has it
    add(u.url, u.documentStyle === "pdf", u.site?.toLowerCase() ?? "unknown", "published");
  }
  return out;
}
