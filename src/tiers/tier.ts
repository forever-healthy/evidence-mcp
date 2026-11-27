// The tier interface. A tier is one retrieval service; the cascade runs the
// configured tiers in order until one yields a checked full text.
//
// Adding a tier = one file in src/tiers/ exporting a `Tier`, registered in
// src/tiers/index.ts. Nothing else changes: tools, status, attempts and the
// ER step stay the same.

export type Paper = {
  title: string;
  pmid: string | null;
  pmcid: string | null;
  doi: string | null;
  headLine: string;      // the metadata line under the title in every .md
  abstract?: string | null;   // the stored abstract's text, where there is one: a full text is checked against it (#7)
  doiLink?: string | null;    // where the DOI leads, for a DOI only doi.org knows (not PubMed, not Crossref): the doi-link tier's page
};

export type TierHit = {
  ok: true;
  tier: string;
  format: "xml" | "html" | "pdf" | "md";   // md: the document's own Markdown source, named by its page (doi-link)
  raw: string | Buffer;  // the original, stored verbatim as -fulltext.<format> (md: -fulltext.source.md)
  md: string;            // the checked Markdown, stored as -fulltext.md
  version: "published" | "accepted_manuscript" | "preprint";
};

export type TierMiss = { ok: false; tier: string; reason: string; skipped?: boolean; ephemeral?: boolean };
// skipped: did not apply, nothing was tried. ephemeral: not worth recording or
// logging — the tier is asked again on the next call.

// A copy of the paper a tier located, for the download helper to fetch.
export type Candidate = {
  url: string;
  version: TierHit["version"];
  source: string;        // the tier that found it
  host: string;          // "publisher" | "repository" | the source name
  pdf: boolean;          // url is believed to be a PDF
  headers?: Record<string, string>;   // credentials a publisher API needs (TDM tokens)
  service?: boolean;     // the proxy tier (a configured service): answers a PDF or XML, anything else is its error message
};
export type TierResult = TierHit | TierMiss;

// What a tier run may use: URLs already fetched in this cascade run (so a
// second locator does not refetch the first one's copy), a log hook, and an
// alert hook for a service refusing the deployment itself (a rejected token,
// an IP not allowed) — logged as a "!!" line, not as a paper's miss.
// lookups: the answers of the tiers' API lookups, started together when the
// cascade begins (Tier.lookup), keyed by tier name.
export type RunContext = { tried: Set<string>; onTry?: (message: string) => void; onAlert?: (message: string) => void; lookups?: Map<string, Promise<string>> };

export interface Tier {
  name: string;
  // true when the tier can apply to this paper, else why not (e.g. "no pmcid");
  // recorded once in attempts as "<name> (<why>)" and never retried.
  applies(p: Paper): true | string;
  run(p: Paper, ctx: RunContext): Promise<TierResult>;
  // The tier's API lookup (where the copies are), a keyless GET: the cascade
  // starts every tier's lookup at once and run() awaits its own answer.
  lookup?(p: Paper): Promise<string>;
}

// The lookup's answer: the one the cascade started, else asked now.
export const looked = (t: Tier, p: Paper, ctx: RunContext): Promise<string> => ctx.lookups?.get(t.name) ?? t.lookup!(p);

export function oaVersion(v: string | null | undefined): TierHit["version"] {
  if (v === "acceptedVersion") return "accepted_manuscript";
  if (v === "submittedVersion") return "preprint";
  return "published";
}

export const miss = (tier: string, reason: string): TierMiss => ({ ok: false, tier, reason });
// One line, no colour codes: Playwright's errors carry a multi-line "Call log"
// with ANSI styling, which has no place in a reason or in evidence.log.
export const errMsg = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0].trim().slice(0, 200);
