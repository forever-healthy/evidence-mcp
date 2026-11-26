import { fetch as undiciFetch } from "undici";
import { timeoutOr } from "./race.js";
import { contactEmail } from "./contact.js";
import { proxyAgent } from "./fetchproxy.js";
// One fetch helper for every tier: timeout, one retry on network errors,
// timeouts, 429 and 5xx; any other HTTP status is final. Returns the body as
// text. Errors carry the tier-neutral reason ("HTTP 403", "timeout", …).

const TIMEOUT_MS = 30_000;

// The User-Agent of a current desktop Chrome (its reduced form, as Chrome
// itself sends it) for page and file downloads — what a reader's browser sends;
// AI4L's fetch tier does the same. API calls keep LIBRARY_UA below.
export const CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
export const BROWSER_HEADERS = {
  "User-Agent": CHROME_UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Identifies the library honestly to every host, with the contact address.
export const LIBRARY_UA = `evidence-mcp (+https://github.com/forever-healthy/evidence-mcp; ${contactEmail()})`;

// A 4xx reason with the service's own code when the body carries one, e.g. Elsevier's
// <statusCode>AUTHENTICATION_ERROR</statusCode> ("HTTP 403 AUTHENTICATION_ERROR") —
// the bare status does not tell a bad key from a paywalled article.
export function httpReason(status: number, body: string): string {
  const m = body.length < 4000 && /<statusCode>([A-Z_]+)<\/statusCode>|"statusCode"\s*:\s*"([A-Z_]+)"/.exec(body);
  return m ? `HTTP ${status} ${m[1] ?? m[2]}` : `HTTP ${status}`;
}

export type Fetched = { bytes: Buffer; contentType: string; url: string };

// Binary fetch for the download tier: same retry rule, returns body, final
// URL after redirects and the Content-Type.
export const DOWNLOAD_HEADERS = { "User-Agent": CHROME_UA, "Accept": "application/pdf,text/html,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" };

// HTTPS only (2026-11-13): an http:// URL is fetched as https://, never over plain
// HTTP; HTTPS failing is the error. Nearly every http:// URL is an old link in a
// metadata record whose site redirects to HTTPS anyway. A redirect down to plain
// HTTP is refused as well.
export const toHttps = (url: string) => url.replace(/^http:\/\//i, "https://");
export const PLAIN_HTTP = "redirected to plain http";
const isPlain = (url: string) => /^http:\/\//i.test(url);

// proxy: an HTTP forward proxy (http://host:port) the request goes through — a fetch-proxy stage (src/fetchproxy.ts).
// signal: cancels the request (a download stage decided by another request, src/race.ts).
export async function fetchBytes(url: string, headers: Record<string, string> = DOWNLOAD_HEADERS, proxy?: string, signal?: AbortSignal): Promise<Fetched> {
  url = toHttps(url);
  let last = "unknown error", finalUrl = "", lastBody = "", lastType = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const init = { headers, signal: timeoutOr(TIMEOUT_MS, signal), redirect: "follow" as const };
      const res = proxy ? await undiciFetch(url, { ...init, dispatcher: proxyAgent(proxy) }) as unknown as Response : await fetch(url, init);
      if (res.url && isPlain(res.url)) throw Object.assign(new Error(`${PLAIN_HTTP} (${new URL(res.url).hostname})`), { final: true });
      if (res.ok) return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "", url: res.url };
      lastBody = (await res.text().catch(() => "")).slice(0, 4000); lastType = res.headers.get("content-type") ?? "";
      last = res.status < 500 ? httpReason(res.status, lastBody) : `HTTP ${res.status}`;
      finalUrl = res.url;
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e;   // a refused downgrade: no retry
      // "fetch failed" alone hides why: the cause's code says it (ECONNREFUSED, ENOTFOUND, a proxy's refusal).
      const code = (e as { cause?: { code?: string; message?: string } })?.cause;
      last = e instanceof Error && e.name === "TimeoutError" ? "timeout" : e instanceof Error ? e.message + (code?.code ? ` (${code.code})` : code?.message ? ` (${code.message})` : "") : String(e);
    }
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  // The URL after redirects, for the next stage; the error body, for a service whose answer is its message.
  throw Object.assign(new Error(last), finalUrl ? { url: finalUrl } : {}, lastBody ? { body: lastBody, contentType: lastType } : {});
}

// NCBI's E-utilities allow 10 requests a second with an API key, 3 without, per key or IP — for the
// whole server, whatever runs at once (the evidence map's searches, library adds, batch fetches).
// Every E-utilities request takes the next free slot: starts at least 1/9 s apart (1/2.5 s without
// a key), a little under the limit (live 2026-11-21: 10 searches at once, one refused). Other server
// processes on the same key (the live hosts run several) are not seen: a refusal (HTTP 429) doubles
// this process's spacing, up to 2 s, and each answer eases it back — processes sharing a key settle
// below the limit together — and the request waits (growing, with jitter, or NCBI's Retry-After)
// and tries again, about 30 s in all before it fails.
export const isNcbi = (url: string): boolean => { try { return new URL(url).hostname === "eutils.ncbi.nlm.nih.gov"; } catch { return false; } };
let ncbiNext = 0, ncbiSlow = 1;
const ncbiBase = (env: NodeJS.ProcessEnv) => (env.FH_NCBI_API_KEY?.trim() ? 1000 / 9 : 400);
export async function ncbiTurn(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const gap = Math.min(2000, ncbiBase(env) * ncbiSlow);
  const now = Date.now(), at = Math.max(now, ncbiNext);
  ncbiNext = at + gap;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}
export const ncbiRefused = (): void => { ncbiSlow = Math.min(32, ncbiSlow * 2); };
export const ncbiAnswered = (): void => { ncbiSlow = Math.max(1, ncbiSlow * 0.9); };
export const ncbiSpacing = (env: NodeJS.ProcessEnv = process.env): number => Math.min(2000, ncbiBase(env) * ncbiSlow);   // tests
export const ncbiReset = (): void => { ncbiNext = 0; ncbiSlow = 1; };   // tests
// The wait before try n+1 after a refusal: NCBI's Retry-After if it gives one, else 1.5 s, 3 s, 6 s, … (at most 10 s), with jitter.
export const ncbiWait = (attempt: number, retryAfter: string | null): number => {
  const s = Number(retryAfter);
  return Number.isFinite(s) && s > 0 ? Math.min(30_000, s * 1000) : Math.min(10_000, 1500 * 2 ** attempt) * (0.75 + Math.random() / 2);
};

export async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  let last = "unknown error";
  const ncbi = isNcbi(url);
  for (let attempt = 0; attempt < (ncbi ? 6 : 2); attempt++) {
    let retryAfter: string | null = null;
    try {
      if (ncbi) await ncbiTurn();
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
      if (res.ok) { if (ncbi) ncbiAnswered(); return await res.text(); }
      if (ncbi && res.status === 429) { ncbiRefused(); retryAfter = res.headers.get("retry-after"); }
      last = res.status < 500 ? httpReason(res.status, await res.text().catch(() => "")) : `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      last = e instanceof Error && e.name === "TimeoutError" ? "timeout" : e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, ncbi ? ncbiWait(attempt, retryAfter) : 1500));
  }
  throw new Error(last);
}
