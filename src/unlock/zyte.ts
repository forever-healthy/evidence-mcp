// Zyte API (`POST https://api.zyte.com/v1/extract`, key as the basic-auth user):
// the URL fetched through Zyte's ban handling, the body back base64-encoded with
// the site's own status and headers. Billed per request by how hard the site is;
// pay-per-use. Key from app.zyte.com.
//
//   FH_ZYTE_API_KEY
//
// 401/402/403/429 from the API are the account's (key, credit, plan limit) —
// "unlocker HTTP <status>", an alert; 520/521 mean Zyte could not get the page
// (a ban it did not get past), a failed stage like any other. A page the site
// answered with an error status is that status ("HTTP 404"), as the plain fetch
// would report it.
import type { Unlocked, UnlockerService } from "../unlock.js";
import { timeoutOr } from "../race.js";

const TIMEOUT_MS = 60_000;   // as every unlocker (src/unlock/brightdata.ts)
const ACCOUNT = new Set([401, 402, 403, 429]);

type Answer = { statusCode?: number; httpResponseBody?: string; httpResponseHeaders?: { name: string; value: string }[]; title?: string; detail?: string };

// A timeout reads "timeout", as Bright Data and the fetch stages say it (not "The operation was aborted due to timeout").
export async function get(url: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Unlocked> {
  try { return await request(url, fetchImpl, signal); }
  catch (e) { throw (e as Error)?.name === "TimeoutError" ? new Error("timeout") : e; }
}

async function request(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Unlocked> {
  const key = process.env.FH_ZYTE_API_KEY?.trim();
  if (!key) throw new Error("not configured");
  const r = await fetchImpl("https://api.zyte.com/v1/extract", {
    method: "POST", signal: timeoutOr(TIMEOUT_MS, signal),
    headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ url, httpResponseBody: true, httpResponseHeaders: true }),
  });
  const j = await r.json().catch(() => ({})) as Answer;
  if (!r.ok) {
    const why = j.title || j.detail || "";
    throw new Error(ACCOUNT.has(r.status) ? `unlocker HTTP ${r.status}${why ? `: ${why}` : ""}` : `HTTP ${r.status}${why ? ` ${why}` : ""}`);
  }
  if (j.statusCode && j.statusCode >= 400) throw new Error(`HTTP ${j.statusCode}`);
  const contentType = j.httpResponseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  return { bytes: Buffer.from(j.httpResponseBody ?? "", "base64"), contentType };
}

export const zyte: UnlockerService = { name: "zyte", keyVar: "FH_ZYTE_API_KEY", get: (url, signal) => get(url, fetch, signal) };
