// Stage 3 of the download (stage 1 fetch, stage 2 browsers): when the plain
// fetch, the fetch proxy and the browsers were all refused (a 403, a bot wall),
// the page is requested through the web unlockers — paid services that fetch it
// through their own proxies and browsers. Optional: without a key nothing
// happens and the failure stands. Never used for NCBI URLs (filtered before),
// never for anything the locate tiers did not report as open access.
//
// Every unlocker with a key takes part; they run at once and the first valid
// answer wins (src/race.ts) — a request already sent may be billed even when its
// answer is not used; without a key an unlocker does not take part. One file per
// service under src/unlock/; a new one is a file and one
// entry in SERVICES (listed best first, as measured on 49 walled URLs:
// stuff/unlock/unlockers.md — Firecrawl, ZenRows, Zyte, Bright Data).
//
//   FH_FIRECRAWL_API_KEY, FH_ZENROWS_API_KEY, FH_ZYTE_API_KEY, FH_BRIGHTDATA_API_KEY (+ FH_BRIGHTDATA_ZONE)
//
// Each unlocker has its own name in the log ("ok zyte", "failed zenrows: HTTP
// 422 …"), in the wall memory and in retrieved_by. A refusal by the service
// itself — "unlocker HTTP 4xx" (key, credit, plan limit, IP not allowed) or
// "unlocker refused" (Auth Failed) — is an alert: ours to fix, not the page's.
// Bright Data's refusal of the page (robots.txt, captcha, the target's status)
// is a failed stage in the other stages' words ("HTTP 500", "challenge not
// cleared (captcha)", "robots.txt restricts <url>"), no alert (src/unlock/brightdata.ts).
//
// 60 s per unlocker (2026-11-13): replaying the comparison, 60 s got all 17
// documents 120 s got, 45 s two fewer.
import { brightdata } from "./unlock/brightdata.js";
import { firecrawl } from "./unlock/firecrawl.js";
import { zenrows } from "./unlock/zenrows.js";
import { zyte } from "./unlock/zyte.js";

export type Unlocked = { bytes: Buffer; contentType: string };
export type UnlockerService = { name: string; keyVar: string; get: (url: string, signal?: AbortSignal) => Promise<Unlocked> };

const SERVICES: UnlockerService[] = [firecrawl, zenrows, zyte, brightdata];
export const UNLOCKER_NAMES = SERVICES.map((s) => s.name);
// A reason or log message that starts with an unlocker's name: "zyte: HTTP 520 …".
export const UNLOCKER_PREFIX = new RegExp(`^(${UNLOCKER_NAMES.join("|")}): `);
// The service refused us, not the page: an alert.
export const accountProblem = (reason: string) => /^unlocker (HTTP 4\d\d|refused)/.test(reason);

const keyed = (s: UnlockerService, env: NodeJS.ProcessEnv) => !!env[s.keyVar]?.trim();

// The unlockers that take part: every one with a key.
export const unlockers = (env: NodeJS.ProcessEnv = process.env): string[] => SERVICES.filter((s) => keyed(s, env)).map((s) => s.name);
export const unlockerConfigured = (): boolean => unlockers().length > 0;

export async function unlock(url: string, name: string, signal?: AbortSignal): Promise<Unlocked> {
  const s = SERVICES.find((x) => x.name === name);
  if (!s) throw new Error(`unknown unlocker ${name}`);
  return s.get(url, signal);
}

// Is an unlocker answering? One request for a tiny, stable page (example.com):
// a refused key, an IP not allowed or the service down show here before a
// download hits them. Costs one request, so fh_info asks it, not every download.
export const HEALTH_URL = "https://example.com/";
export async function unlockerHealth(name: string, unlockImpl: (url: string, name: string) => Promise<Unlocked> = unlock): Promise<{ ok: boolean; ms: number; error: string | null }> {
  const t0 = Date.now();
  try {
    const u = await unlockImpl(HEALTH_URL, name);
    const ok = /Example Domain/.test(u.bytes.toString("utf8"));
    return { ok, ms: Date.now() - t0, error: ok ? null : u.bytes.length ? `unexpected answer (${u.bytes.length} bytes)` : "empty answer" };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}
