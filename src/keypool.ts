import { str } from "./env.js";
import { type Ask, describe, type Headers, rawAsk, Refusal, type ScreenConfig, shortMessage, statusOf, where } from "./screen.js";

// A pool of API keys for the screening (#102): FH_EVMAP_SCREENING_POOL_KEY_<n>, any number of
// them, each its own account with its own credit and rate limit. Calls go over the awake keys in
// turn; a key out of credit sleeps for a day and is tried again; when every pool key is asleep the
// screening's own key (the master key) takes the calls. The pool keys use the screening's
// provider, model and URL. Which keys sleep is kept in memory only: after a restart an empty key
// says so on its first call.

export type PoolKey = { n: number; key: string };
export const poolKeys = (env: NodeJS.ProcessEnv = process.env): PoolKey[] =>
  Object.keys(env).map((k) => /^FH_EVMAP_SCREENING_POOL_KEY_(\d+)$/.exec(k)).filter((m): m is RegExpExecArray => !!m && !!str(m[0], env))
    .map((m) => ({ n: Number(m[1]), key: str(m[0], env) })).sort((a, b) => a.n - b.n);

export const SLEEP_MS = 24 * 3600 * 1000;
// Anthropic, checked with an empty key 2026-11-25: HTTP 400 invalid_request_error, "Your credit
// balance is too low to access the Anthropic API. …", not to be retried.
// A refusal that is about the key, not the request (2026-11-25: HTTP 400 "This API key is not scoped to a workspace …").
export const notAccepted = (message: string): boolean => /api key|api_key|x-api-key/i.test(message);
export const outOfCredit = (message: string): boolean => /credit balance is too low|insufficient_quota/i.test(message);

// Calls at once per key. One key at 10 million input tokens and 13,000 requests a minute carries
// the screening's 400 calls at once; a key's share follows the limits its answers state
// (anthropic-ratelimit-*): 2 million input tokens a minute → 80. Until a key has answered: 80.
export const PER_KEY = 80;
export function capacity(h: Headers): number | null {
  const tokens = Number(h.get("anthropic-ratelimit-input-tokens-limit")), requests = Number(h.get("anthropic-ratelimit-requests-limit"));
  const by = [tokens > 0 ? tokens / 25_000 : null, requests > 0 ? requests / 50 : null].filter((x): x is number => x !== null);
  return by.length ? Math.max(1, Math.min(400, Math.floor(Math.min(...by)))) : null;
}

type Slot = PoolKey & { name: string; ask: Ask; busy: number; cap: number; until: number; calls: number; used: number };
const OUT = Number.POSITIVE_INFINITY;   // a key the provider does not accept: out until the server restarts

export type Pool = { ask: Ask; counts: () => string };
// make: the call for one key (tests); note: a line for the log; now: the clock (tests).
export function keyPool(c: Extract<ScreenConfig, { ok: true }>, keys: PoolKey[], o: { note?: (line: string) => void; now?: () => number; make?: (key: string, seen: (h: Headers) => void) => Ask } = {}): Pool {
  const note = o.note ?? (() => {}), now = o.now ?? Date.now;
  const make = o.make ?? ((key, seen) => rawAsk({ ...c, key }, seen));
  const slots: Slot[] = keys.map((k) => {
    const s: Slot = { ...k, name: `pool key ${k.n} …${k.key.slice(-4)}`, ask: async () => { throw new Error("no call"); }, busy: 0, cap: PER_KEY, until: 0, calls: 0, used: 0 };
    s.ask = make(k.key, (h) => { const n = capacity(h); if (n) s.cap = n; });
    return s;
  });
  const master = make(c.key, () => {});
  let masterCalls = 0, onMaster = false, turn = 0;
  let waiting: (() => void)[] = [];
  const wake = () => { const w = waiting; waiting = []; for (const f of w) f(); };

  // An awake pool key with room for one more call (its place taken), the least used first; null: none is awake (or all were tried).
  const take = async (tried: Set<Slot>): Promise<Slot | null> => {
    for (;;) {
      const t = now();
      for (const s of slots) if (s.until > 0 && s.until <= t) { s.until = 0; note(`${s.name} awake again after a day: tried`); }
      const awake = slots.filter((s) => s.until === 0 && !tried.has(s));
      if (!awake.length) return null;
      const free = awake.filter((s) => s.busy < s.cap).sort((a, b) => a.busy / a.cap - b.busy / b.cap || a.used - b.used);
      if (free.length) { free[0].busy++; return free[0]; }   // the place is taken here: several calls ask at once
      await new Promise<void>((ok) => waiting.push(ok));
    }
  };

  const ask: Ask = async (text) => {
    const tried = new Set<Slot>();
    let limited: unknown;
    for (;;) {
      const s = await take(tried);
      if (!s) {
        // every key that was awake refused for its rate limit: that is the answer, the master key is for empty keys
        if (limited && slots.some((x) => x.until === 0)) throw new Error(describe(limited, where(c), c.vars));
        if (!onMaster) { onMaster = true; note("every pool key asleep: the master key takes the screening"); }
        masterCalls++;
        try { return await master(text); } catch (e) { throw e instanceof Refusal ? e : new Error(describe(e, where(c), c.vars)); }
      }
      if (onMaster) { onMaster = false; note(`${s.name} takes the screening again, the master key rests`); }
      s.calls++; s.used = ++turn;
      try { return await s.ask(text); } catch (e) {
        if (e instanceof Refusal) throw e;
        const status = statusOf(e), message = e instanceof Error ? e.message : String(e);
        const setting = `FH_EVMAP_SCREENING_POOL_KEY_${s.n}`;
        if (outOfCredit(message)) {
          if (s.until === 0) { s.until = now() + SLEEP_MS; note(`${s.name} out of credit: asleep until ${new Date(s.until).toISOString().slice(0, 16).replace("T", " ")} UTC`); }
        } else if (status === 401 || status === 403 || notAccepted(message)) {
          if (s.until === 0) { s.until = OUT; note(`!! ${s.name} not accepted (${shortMessage(message)}): out until the server restarts — ${setting}`); }
        } else if (status === 429) { tried.add(s); limited = e; }
        else throw new Error(describe(e, where(c), { key: setting, model: c.vars?.model ?? "FH_EVMAP_SCREENING_MODEL", url: c.vars?.url ?? "FH_EVMAP_SCREENING_URL" }));
      } finally { s.busy--; wake(); }
    }
  };

  // The calls per key since the last count, in the order of the keys' numbers, for one log line after a screening; "" when no call was made.
  const counts = () => {
    const t = now();
    const line = [...slots.map((s) => `${s.calls}${s.until === OUT ? " (out)" : s.until > t ? " (asleep)" : ""}`), `master ${masterCalls}`].join(" · ");
    const any = masterCalls > 0 || slots.some((s) => s.calls > 0);
    for (const s of slots) s.calls = 0;
    masterCalls = 0;
    return any ? line : "";   // nothing to say when every abstract came from the cache
  };
  return { ask, counts };
}

// One pool per process for the same settings: which keys sleep has to hold across the rounds of a
// build and from one map to the next (each takes its screener anew).
const shared = new Map<string, Pool>();
export function sharedPool(c: Extract<ScreenConfig, { ok: true }>, keys: PoolKey[], note: (line: string) => void): Pool {
  const id = JSON.stringify([c.provider, c.url, c.model, c.key, keys]);
  let p = shared.get(id);
  if (!p) shared.set(id, p = keyPool(c, keys, { note }));
  return p;
}
