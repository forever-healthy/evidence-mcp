import { checkFulltext } from "../checks.js";
import { parseJats, renderFulltextMd } from "../jats.js";
import { contactEmail } from "../contact.js";
import { fetchText } from "../http.js";
import { errMsg, miss, type Paper, type Tier, type TierResult } from "./tier.js";

// pmc: full text as JATS XML via efetch(db=pmc). Some publishers withhold it;
// the XML then has no <body>.

export function pmcEfetchUrl(pmcid: string): string {
  const u = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
  u.searchParams.set("db", "pmc");
  u.searchParams.set("id", pmcid.replace(/^PMC/i, ""));
  u.searchParams.set("retmode", "xml");
  if (process.env.FH_NCBI_API_KEY) u.searchParams.set("api_key", process.env.FH_NCBI_API_KEY);
  u.searchParams.set("tool", "evidence-mcp");
  u.searchParams.set("email", contactEmail());
  return u.toString();
}

export const pmc: Tier = {
  name: "pmc",
  applies: (p: Paper) => (p.pmcid ? true : "no pmcid"),
  async run(p: Paper): Promise<TierResult> {
    let xml: string;
    try { xml = await fetchText(pmcEfetchUrl(p.pmcid!)); } catch (e) { return miss(this.name, errMsg(e)); }
    const doc = parseJats(xml);
    if (!doc.hasBody) return miss(this.name, "no body");
    const md = renderFulltextMd(doc, p.headLine);
    const check = checkFulltext(md, p.title);
    if (!check.ok) return miss(this.name, check.reason);
    return { ok: true, tier: this.name, format: "xml", raw: xml, md, version: "published" };
  },
};
