import { contactEmail } from "../contact.js";
import { download } from "../download.js";
import { fetchText, LIBRARY_UA } from "../http.js";
import { errMsg, looked, miss, type Candidate, type Paper, type RunContext, type Tier, type TierResult } from "./tier.js";

// tdm: the publishers' own text-and-data-mining routes. Crossref lists, per
// DOI, the links a publisher registered for text mining; the big ones need a
// token in a header. Tokens come from the tier's config entry
// ("tokens": { "elsevier": "${ELSEVIER_API_KEY}", "wiley": "…" }) or, when
// absent there, from the environment variables of the same names:
//
//   elsevier / ELSEVIER_API_KEY   api.elsevier.com  (X-ELS-APIKey; full text for
//                                 open-access and entitled articles, else abstract only)
//   wiley    / WILEY_TDM_TOKEN    api.wiley.com     (Wiley-TDM-Client-Token; PDF)
//
// Links on other hosts are fetched as they are. A host whose token is not set
// is skipped and the entry says so, so setting the token later retries it.

const CROSSREF = "https://api.crossref.org/works/";

type Link = { URL: string; "content-type"?: string; "intended-application"?: string };
export type CrossrefWork = { message?: { link?: Link[]; publisher?: string } };

export type TdmTokens = { elsevier?: string; wiley?: string };

const TOKENED: { host: RegExp; key: keyof TdmTokens; env: string; header: string }[] = [
  { host: /(^|\.)api\.elsevier\.com$/i, key: "elsevier", env: "ELSEVIER_API_KEY", header: "X-ELS-APIKey" },
  { host: /(^|\.)api\.wiley\.com$/i, key: "wiley", env: "WILEY_TDM_TOKEN", header: "Wiley-TDM-Client-Token" },
];

const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };

export function tdmCandidates(work: CrossrefWork, tokens: TdmTokens = {}, env: NodeJS.ProcessEnv = process.env): { candidates: Candidate[]; missingTokens: string[] } {
  const links = (work.message?.link ?? []).filter((l) => l["intended-application"] === "text-mining" && l.URL);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const missingTokens = new Set<string>();
  for (const l of links) {
    const ct = (l["content-type"] ?? "").toLowerCase();
    if (seen.has(l.URL)) {
      const prev = candidates.find((c) => c.url === l.URL);
      if (prev && /pdf/.test(ct)) prev.pdf = true;
      continue;
    }
    seen.add(l.URL);
    const rule = TOKENED.find((r) => r.host.test(hostOf(l.URL)));
    let headers: Record<string, string> | undefined;
    if (rule) {
      const token = tokens[rule.key]?.trim() || env[rule.env]?.trim();
      if (!token) { missingTokens.add(rule.key); continue; }
      headers = { [rule.header]: token };
    }
    // Elsevier: XML is the useful form; plain text has no structure.
    if (/text\/plain/.test(ct)) continue;
    candidates.push({ url: l.URL, version: "published", source: "tdm", host: work.message?.publisher ?? hostOf(l.URL), pdf: /pdf/.test(ct) || /\.pdf(\?|$)/i.test(l.URL), headers });
  }
  // Prefer XML (structure survives) over PDF, unspecified last.
  const rank = (c: Candidate) => (/\/xml|text\/xml/.test(c.url) ? 0 : c.pdf ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b));
  return { candidates, missingTokens: [...missingTokens] };
}

export function tdmTier(tokens: TdmTokens = {}): Tier {
  return {
  name: "tdm",
  applies: (p: Paper) => (p.doi ? true : "no doi"),
  lookup: (p: Paper) => fetchText(CROSSREF + encodeURIComponent(p.doi!), { "User-Agent": `${LIBRARY_UA} (mailto:${contactEmail()})` }),
  async run(p: Paper, ctx: RunContext): Promise<TierResult> {
    let work: CrossrefWork;
    try { work = JSON.parse(await looked(this, p, ctx)); } catch (e) { return miss(this.name, errMsg(e)); }
    const { candidates, missingTokens } = tdmCandidates(work, tokens);
    // Only links behind a token we do not have: nothing was tried, so this is a
    // skip, not a failure (grey in the TUI; still recorded so a token added later retries).
    if (!candidates.length) return missingTokens.length ? { ...miss(this.name, `needs ${missingTokens.join("/")} token`), skipped: true } : miss(this.name, "no text-mining links");
    ctx.onTry?.(`${candidates.length} text-mining links${missingTokens.length ? ` (skipped hosts needing ${missingTokens.join("/")} token)` : ""}`);
    return download(this.name, p, candidates, ctx);
  },
  };
}

export const tdm = tdmTier();
