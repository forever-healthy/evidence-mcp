import type { VerifyConfig } from "./config.js";

export type Decisions = Record<string, { type: "noul"; instructions: string }>;
export type Answers = Record<string, { noul?: number }>;
export type Decide = (state: unknown, questions: Decisions) => Promise<Answers>;

// One Decisions API request, shaped by the configured provider
// (src/verify/providers.ts). Errors carry the service's message; a timeout
// names the size of what was sent.
let RETRY_MS = 2000;
let WAIT_SCALE = 1;   // tests shrink the rate-limit waits
export const setRetryMs = (ms: number, waitScale = 1) => { RETRY_MS = ms; WAIT_SCALE = waitScale; };   // tests
// A rate limit (HTTP 429, "rate limit"): wait as long as the service asks
// ("retry in 12s", Retry-After), at most 60 s, then again — twice at most. A free
// tier counts tokens per minute (Google's: 50,000), so a burst of full texts
// waits instead of failing; a single paper over the limit still fails after two waits.
const RATE_LIMITED = /rate limit|quota|resource.?exhausted/i;
function waitSeconds(r: Response, msg: string): number {
  const asked = Number(/retry in (\d+(?:\.\d+)?)\s*s/i.exec(msg)?.[1] ?? r.headers.get("retry-after") ?? NaN);
  return Math.min(60, Number.isFinite(asked) && asked > 0 ? asked + 1 : 15);
}
export function decider(cfg: VerifyConfig, fetchFn: typeof fetch = fetch): Decide {
  return async (state, questions) => {
    const { url, headers, body } = cfg.provider.request({ base_url: cfg.base_url, api_key: cfg.api_key, model: cfg.model, state, questions });
    // One retry when the service itself is down for a moment — HTTP 502/503/504
    // or "temporarily unavailable" (3 of 41 verify errors on dev, 2026-11-09);
    // not after our own timeout, which would only double the wait.
    let waits = 0;
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      try {
        r = await fetchFn(url, { method: "POST", headers, body, signal: AbortSignal.timeout(cfg.timeout_seconds * 1000) });
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        if (name === "TimeoutError" || name === "AbortError" || cause?.code === "UND_ERR_HEADERS_TIMEOUT") throw new Error(`${cfg.model}: no answer within ${cfg.timeout_seconds}s (${body.length} chars)`);
        throw new Error(`${cfg.model}: ${cause?.message ?? (e instanceof Error ? e.message : String(e))}`);
      }
      const j = await r.json().catch(() => ({})) as { answers?: Answers; error?: { message?: string } | string };
      let answers: Answers | null;
      try { answers = cfg.provider.parse ? cfg.provider.parse(j) : j.answers ?? null; }
      catch (e) { throw new Error(`${cfg.model}: ${e instanceof Error ? e.message : String(e)}`); }   // a refusal: final, not retried
      if (answers) return answers;
      const msg = typeof j.error === "string" ? j.error : j.error?.message;
      if ((r.status === 429 || RATE_LIMITED.test(msg ?? "")) && waits < 2) {
        waits++;
        await new Promise((res) => setTimeout(res, waitSeconds(r, msg ?? "") * 1000 * WAIT_SCALE));
        continue;
      }
      if (attempt === 0 && ([502, 503, 504].includes(r.status) || /temporarily unavailable|overloaded|try again|retry your request/i.test(msg ?? ""))) {
        await new Promise((res) => setTimeout(res, RETRY_MS));
        continue;
      }
      // The model's name once: LM Studio's messages already begin with it ("d1-2b: input … too large")
      throw new Error(msg ? (msg.startsWith(`${cfg.model}: `) ? msg : `${cfg.model}: ${msg}`) : `${cfg.model}: HTTP ${r.status} without an answer`);
    }
  };
}
