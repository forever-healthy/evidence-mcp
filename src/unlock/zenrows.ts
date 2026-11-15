// ZenRows Fetch (`GET https://api.zenrows.com/v1/?apikey=…&url=…`): the URL
// fetched through ZenRows' proxies and browsers, the body back as the site sent
// it. `mode=auto` lets ZenRows pick the cheapest setup that succeeds and climb
// to JavaScript rendering and residential proxies only when needed; only the
// setup that worked is billed. Subscription plans; key from app.zenrows.com.
//
//   FH_ZENROWS_API_KEY
//
// Errors come as JSON with a status: 401/402/403/429 are the account's (key,
// credits, plan limit) — "unlocker HTTP <status>", an alert; any other is the
// target that could not be got, a failed stage like any other.
import type { Unlocked, UnlockerService } from "../unlock.js";
import { timeoutOr } from "../race.js";

const TIMEOUT_MS = 60_000;   // as every unlocker (src/unlock/brightdata.ts)
const ACCOUNT = new Set([401, 402, 403, 429]);

export async function get(url: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Unlocked> {
  const key = process.env.FH_ZENROWS_API_KEY?.trim();
  if (!key) throw new Error("not configured");
  const r = await fetchImpl(`https://api.zenrows.com/v1/?apikey=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}&mode=auto`, { signal: timeoutOr(TIMEOUT_MS, signal) });
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!r.ok) {
    let why = "";
    try { const j = JSON.parse(bytes.toString("utf8")) as { title?: string; detail?: string; code?: string }; why = j.title || j.detail || j.code || ""; } catch { why = bytes.toString("utf8").slice(0, 120).trim(); }
    throw new Error(ACCOUNT.has(r.status) ? `unlocker HTTP ${r.status}${why ? `: ${why}` : ""}` : `HTTP ${r.status}${why ? ` ${why}` : ""}`);
  }
  return { bytes, contentType: r.headers.get("content-type") ?? "" };
}

export const zenrows: UnlockerService = { name: "zenrows", keyVar: "FH_ZENROWS_API_KEY", get: (url, signal) => get(url, fetch, signal) };
