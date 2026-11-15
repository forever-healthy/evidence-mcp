import { download } from "../download.js";
import { miss, type Paper, type RunContext, type Tier, type TierResult } from "./tier.js";

// The proxy tier — a URL template filled from the paper's IDs, fetched through
// the download helper: an institutional proxy, a licensed service, a local
// mirror. One per deployment, named "proxy" (src/config.ts):
//
//   FH_PROXY_URL=https://proxy.example.org/login?url=https://doi.org/{doi}
//   FH_PROXY_HEADERS=Authorization: Bearer <token>
//
// Placeholders: {doi} {pmid} {pmcid}. The tier applies only when every
// placeholder it uses is known for the paper. The service answers the paper as a
// PDF or as XML (JATS, Elsevier); any other body is its error message, recorded
// as "service: <message>" and retried after the cooldown.

const PLACEHOLDERS = ["doi", "pmid", "pmcid"] as const;

export function urlTier(name: string, template: string, headers?: Record<string, string>): Tier {
  const used = PLACEHOLDERS.filter((k) => template.includes(`{${k}}`));
  return {
    name,
    applies(p: Paper) {
      const missing = used.filter((k) => !p[k]);
      return missing.length ? `no ${missing.join("/")}` : true;
    },
    async run(p: Paper, ctx: RunContext): Promise<TierResult> {
      if (!used.length) return miss(name, "template has no placeholder");
      const url = used.reduce((u, k) => u.replaceAll(`{${k}}`, encodeURIComponent(p[k]!)), template);
      return download(name, p, [{ url, version: "published", source: name, host: "user", pdf: /\.pdf(\?|$)/i.test(url), headers, service: true }], ctx);
    },
  };
}
