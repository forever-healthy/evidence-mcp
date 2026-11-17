// Bright Data's Web Unlocker (`POST https://api.brightdata.com/request`, key
// as a bearer token): the URL fetched through Bright Data's proxies and
// browsers, the body back raw.
//
//   FH_BRIGHTDATA_API_KEY     account API key (Bright Data calls it API token)
//   FH_BRIGHTDATA_ZONE        Web Unlocker zone name (default: mcp_unlocker, the
//                             zone the Bright Data MCP creates)
//
// A zone may hold an IP allowlist and denylist: a request from an address not
// allowed answers HTTP 407, one on the denylist HTTP 200 with an empty body and
// x-brd-error — both are the account's problem, reported as such.

import { request as httpsRequest } from "node:https";
import type { Unlocked, UnlockerService } from "../unlock.js";
import { timeoutOr } from "../race.js";

const ENDPOINT = "https://api.brightdata.com/request";
const TIMEOUT_MS = 60_000;   // every unlocker: on the comparison (#64) 60 s lost no document against 120 s in the ordered chain, and halves the worst case

// The request goes over node:https, not fetch: Node's fetch follows the Fetch
// standard, where a 407 is a "network error" without a status — so Bright
// Data's refusal of an IP that is not allowlisted (HTTP 407, "You are not
// allowed to access our API via this IP") surfaced as a bare "fetch failed"
// (found 2026-11-08). A plain HTTPS request returns the 407 and its
// x-brd-err-msg header like any other status. The reply has the parts of a
// fetch Response the code reads, so a test may pass a fetch-like fake.
// Bright Data's refusals of the page, in the words the other stages use: the target's status as
// "HTTP 500" (as Zyte and ZenRows say it), a captcha as a challenge not cleared (as the browsers),
// a robots.txt rule as "robots.txt restricts <url>". null: a refusal of us (Auth Failed, a zone).
export function pageReason(error: string, msg: string): string | null {
  const t = `${error} ${msg}`;
  const st = /response status was rejected: (\d{3})/i.exec(t);
  if (st) return `HTTP ${st[1]}`;
  const rb = /Requested URL \((.+?)\) is restricted in accordance with robots\.txt/.exec(t);   // in x-brd-error (live 2026-11-15), x-brd-err-msg empty
  if (rb) return `robots.txt restricts ${rb[1]}`;
  if (/robots\.txt/i.test(t)) return "robots.txt restricts the page";
  if (/captcha|protection page/i.test(t)) return "challenge not cleared (captcha)";
  if (/Residential Failed/i.test(t)) return "no residential exit";
  return null;
}

export type Reply = { ok: boolean; status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> };
export type PostInit = { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal };
export function post(url: string, init: PostInit): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "POST", headers: { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) }, signal: init.signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300, status,
          headers: { get: (name) => { const v = res.headers[name.toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(", ") : v; } },
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        });
      });
    });
    req.on("error", (e: Error) => reject(e.name === "AbortError" || e.name === "TimeoutError" ? new Error("timeout") : e));
    req.end(init.body);
  });
}

const apiKey = () => process.env.FH_BRIGHTDATA_API_KEY?.trim() || "";

export async function get(url: string, postImpl: (url: string, init: PostInit) => Promise<Reply> = post, signal?: AbortSignal): Promise<Unlocked> {
  const token = apiKey();
  if (!token) throw new Error("not configured");
  const zone = process.env.FH_BRIGHTDATA_ZONE?.trim() || "mcp_unlocker";
  const res = await postImpl(ENDPOINT, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone, url, format: "raw" }),
    signal: timeoutOr(TIMEOUT_MS, signal),
  });
  // Bright Data says why in a header (a token not allowed from this IP, a wrong
  // zone); the body is empty. Some refusals come with HTTP 200: an IP on the
  // zone's denylist answers 200, an empty body and x-brd-error "Auth Failed
  // (code: ip_blacklisted)" (found 2026-11-13; it read as "empty response").
  const why = res.headers.get("x-brd-err-msg") ?? res.headers.get("x-brd-error");
  if (!res.ok) throw new Error(`unlocker HTTP ${res.status}${why ? `: ${why}` : ""}`);
  // Most refusals are of the page, not of us (live, 2026-11-13–15: 80 of 80): robots.txt (Wiley's
  // full-text links redirect to its action/oidcStart sign-in, ScienceDirect, JBS), a captcha it
  // could not clear, the target's own 403/500/503, no residential exit — a failed stage in the
  // other stages' words (pageReason), no alert; robots.txt and the captcha are walls
  // (src/walls.ts). Any other refusal (Auth Failed, a zone) is "unlocker refused": an alert, ours to fix.
  const err = res.headers.get("x-brd-error");
  if (err) throw new Error(pageReason(err, res.headers.get("x-brd-err-msg") ?? "") ?? `unlocker refused: ${why}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "" };
}

export const brightdata: UnlockerService = { name: "brightdata", keyVar: "FH_BRIGHTDATA_API_KEY", get: (url, signal) => get(url, post, signal) };
