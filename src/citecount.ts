import { openalexParams } from "./contact.js";
import { fetchText } from "./http.js";

// Citation counts for the evidence map's ranking (README-evmap.md → The process, Screening): OpenAlex's cited_by_count for a batch of PMIDs, 50 per request, a few
// requests at once. A failed batch leaves its PMIDs without a count — the ranking
// then goes without the signal for them; nothing fails because of it.
// Bench 2026-11-19 (8 evipedia reviews): citations per year lifted the backbone
// papers in the top 100 from 29 to 39 of 80.

export const BATCH = 50;
const OA = "https://api.openalex.org";
export type Fetch = (url: string) => Promise<string>;
const live: Fetch = (url) => fetchText(url, { "User-Agent": "evidence-mcp", Accept: "application/json" });

export const countsUrl = (pmids: string[]): string => `${OA}/works?filter=pmid:${pmids.join("|")}&per-page=${BATCH}&select=ids,cited_by_count&${openalexParams()}`;

// pmid → cited_by_count; a PMID OpenAlex does not know, or whose batch failed, is absent.
export async function citationCounts(pmids: string[], fetchImpl: Fetch = live, parallel = 4): Promise<{ counts: Map<string, number>; failed: number; error?: string }> {
  const counts = new Map<string, number>();
  const batches: string[][] = [];
  for (let i = 0; i < pmids.length; i += BATCH) batches.push(pmids.slice(i, i + BATCH));
  let next = 0, failed = 0, error: string | undefined;
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++];
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d: any = JSON.parse(await fetchImpl(countsUrl(b)));
        for (const w of d?.results ?? []) {
          const pmid = String(w?.ids?.pmid ?? "").split("/").pop();
          if (pmid && typeof w.cited_by_count === "number") counts.set(pmid, w.cited_by_count);
        }
      } catch (e) { failed += b.length; error ??= e instanceof Error ? e.message : String(e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
  return { counts, failed, ...(error ? { error } : {}) };
}

// Citations per year since publication (the publication year counts as one).
export const perYear = (count: number, year: string | null, now = new Date()): number => count / Math.max(1, now.getUTCFullYear() - (Number(year) || now.getUTCFullYear()) + 1);
