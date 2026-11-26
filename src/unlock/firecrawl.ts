// Firecrawl Cloud (`POST https://api.firecrawl.dev/v2/scrape`, key as a bearer token):
// the page fetched through Firecrawl's proxies — basic first, its stealth proxy
// (Fire-engine) when that fails (proxy "auto"). formats rawHtml with parsers []:
// the page's own HTML, or a PDF as its bytes (base64) instead of Firecrawl's
// Markdown, so the server converts it like any other download. A subscription (free tier) of credits
// (1 a page; stealth more). Key from https://www.firecrawl.dev/app.
//
//   FH_FIRECRAWL_API_KEY
//
// 401/402/403/429 from the API are the account's (key, credit, plan limit) —
// "unlocker HTTP <status>", an alert; any other failure is a failed stage. A page
// the site answered with an error status is that status ("HTTP 404"), as the plain
// fetch would report it.
import type { Unlocked, UnlockerService } from "../unlock.js";
import { timeoutOr } from "../race.js";

const TIMEOUT_MS = 60_000;   // as every unlocker (src/unlock/brightdata.ts)
const ACCOUNT = new Set([401, 402, 403, 429]);

type Answer = { success?: boolean; error?: string; data?: { rawHtml?: string; metadata?: { statusCode?: number; contentType?: string; error?: string } } };

// A timeout reads "timeout", as the other stages say it.
export async function get(url: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Unlocked> {
  try { return await request(url, fetchImpl, signal); }
  catch (e) { throw (e as Error)?.name === "TimeoutError" ? new Error("timeout") : e; }
}

async function request(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Unlocked> {
  const key = process.env.FH_FIRECRAWL_API_KEY?.trim();
  if (!key) throw new Error("not configured");
  const r = await fetchImpl("https://api.firecrawl.dev/v2/scrape", {
    method: "POST", signal: timeoutOr(TIMEOUT_MS, signal),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ url, formats: ["rawHtml"], parsers: [], proxy: "auto", timeout: TIMEOUT_MS - 5_000 }),
  });
  const j = await r.json().catch(() => ({})) as Answer;
  if (!r.ok || !j.success) {
    const why = (j.error ?? "").replace(/\s+/g, " ").slice(0, 200);
    throw new Error(ACCOUNT.has(r.status) ? `unlocker HTTP ${r.status}${why ? `: ${why}` : ""}` : `HTTP ${r.status}${why ? ` ${why}` : ""}`);
  }
  const m = j.data?.metadata;
  if (m?.statusCode && m.statusCode >= 400) throw new Error(`HTTP ${m.statusCode}`);
  const contentType = m?.contentType ?? "";
  const raw = j.data?.rawHtml ?? "";
  // A PDF (or another binary file) comes base64-encoded; a page as its HTML.
  const binary = /pdf|octet-stream/i.test(contentType) || raw.startsWith("JVBERi");
  return { bytes: binary ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8"), contentType };
}

export const firecrawl: UnlockerService = { name: "firecrawl", keyVar: "FH_FIRECRAWL_API_KEY", get: (url, signal) => get(url, fetch, signal) };
