import { openalexParams } from "./contact.js";
import { fetchText } from "./http.js";

// Backward citation searching for the evidence map (README-evmap.md → The process, Citations): the reference lists of the map's top reviews, from OpenAlex. For each
// review its referenced works, resolved to PMIDs; an article included by several of
// the found reviews is what a review rests on — the strongest signal for the backbone
// ("in 4 of 6 reviews"), and the articles not found by the queries become candidates.

const OA = "https://api.openalex.org";
const BATCH = 50;
export type Fetch = (url: string) => Promise<string>;
const live: Fetch = (url) => fetchText(url, { "User-Agent": "evidence-mcp", Accept: "application/json" });
const pmidOf = (w: { ids?: { pmid?: string } }) => String(w?.ids?.pmid ?? "").split("/").pop() || null;

async function pool<T>(items: T[], parallel: number, fn: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

// review PMID → the PMIDs of the works it references (those with a PMID).
export async function referencedPmids(reviews: string[], fetchImpl: Fetch = live, parallel = 4): Promise<{ refs: Map<string, string[]>; failed: number }> {
  const works = new Map<string, string[]>();   // review pmid → OpenAlex work IDs
  let failed = 0;
  const chunks: string[][] = [];
  for (let i = 0; i < reviews.length; i += BATCH) chunks.push(reviews.slice(i, i + BATCH));
  await pool(chunks, parallel, async (c) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = JSON.parse(await fetchImpl(`${OA}/works?filter=pmid:${c.join("|")}&per-page=${BATCH}&select=ids,referenced_works&${openalexParams()}`));
      for (const w of d?.results ?? []) { const p = pmidOf(w); if (p) works.set(p, (w.referenced_works ?? []).map((u: string) => u.split("/").pop())); }
    } catch { failed += c.length; }
  });
  const all = [...new Set([...works.values()].flat())];
  const toPmid = new Map<string, string>();
  const wchunks: string[][] = [];
  for (let i = 0; i < all.length; i += BATCH) wchunks.push(all.slice(i, i + BATCH));
  await pool(wchunks, parallel, async (c) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = JSON.parse(await fetchImpl(`${OA}/works?filter=openalex:${c.join("|")}&per-page=${BATCH}&select=id,ids&${openalexParams()}`));
      for (const w of d?.results ?? []) { const p = pmidOf(w); if (p) toPmid.set(String(w.id).split("/").pop()!, p); }
    } catch { failed += c.length; }
  });
  const refs = new Map<string, string[]>();
  for (const [review, ws] of works) refs.set(review, [...new Set(ws.map((w) => toPmid.get(w)).filter((p): p is string => !!p))]);
  return { refs, failed };
}

// How many of the reviews include each PMID.
export function inclusionCounts(refs: Map<string, string[]>): Map<string, number> {
  const n = new Map<string, number>();
  for (const list of refs.values()) for (const p of list) n.set(p, (n.get(p) ?? 0) + 1);
  return n;
}
