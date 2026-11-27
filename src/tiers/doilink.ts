import { download } from "../download.js";
import { fetchText, LIBRARY_UA } from "../http.js";
import { miss, type Candidate, type Paper, type RunContext, type Tier, type TierResult } from "./tier.js";

// doi-link: the page a DOI leads to, for a DOI that neither PubMed nor Crossref knows — DataCite's and other
// registries' (reports, reviews, datasets, repository uploads). The other tiers ask services where a copy of a
// journal article is; none of them knows such a DOI, and its own link usually is the document (evipedia.ai's
// reviews, 2026-11-27: record and abstract from doi.org, no full text from any tier). Last in the order.
// Not for a Crossref DOI: its link is the publisher's page — where that is open, unpaywall and openalex name it
// as a copy; where it is not, fetching it costs the browsers and unlockers a round per paper for a paywall.
//
// A page that names its Markdown source (<link rel="alternate" type="text/markdown" href>) is read from there
// first: the document as written, where the page may show it in parts or build it by script (evipedia.ai's page
// holds 700 of a review's 7,000 words). Either copy passes the same checks as any other (src/checks.ts).
export const doilink: Tier = {
  name: "doi-link",
  applies: (p: Paper) => (p.doiLink ? true : "a PubMed or Crossref record"),
  lookup: (p: Paper) => fetchText(p.doiLink!, { "User-Agent": LIBRARY_UA, Accept: "text/html" }),
  async run(p: Paper, ctx: RunContext): Promise<TierResult> {
    if (!p.doiLink) return miss(this.name, "no link");
    const page: Candidate = { url: p.doiLink, version: "published", source: this.name, host: "publisher", pdf: /\.pdf($|[?#])/i.test(p.doiLink) };
    let source: string | null = null;
    try { source = markdownSource(await (ctx.lookups?.get(this.name) ?? this.lookup!(p)), p.doiLink); } catch { /* the page is fetched below, through every stage */ }
    if (source) ctx.onTry?.(`markdown source → ${source.replace(/^https?:\/\//, "")}`);
    return download(this.name, p, [...(source ? [{ ...page, url: source, pdf: false }] : []), page], ctx);
  },
};

// The Markdown source a page names in its head, as an absolute URL.
export function markdownSource(html: string, pageUrl: string): string | null {
  for (const tag of html.slice(0, 200_000).match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel=["']?alternate\b/i.test(tag) || !/\btype=["']?text\/(x-)?markdown\b/i.test(tag)) continue;
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try { const u = new URL(href, pageUrl); if (/^https?:$/.test(u.protocol)) return u.href; } catch { /* not a URL */ }
  }
  return null;
}
