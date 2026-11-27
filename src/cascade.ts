import { resolveTiers, settings } from "./config.js";
import { miss, type Paper, type RunContext, type Tier, type TierHit, type TierMiss, type TierResult } from "./tiers/tier.js";

// The full-text cascade: runs the configured tiers in order until one yields
// a checked full text. A tier already in `attempts` is not retried
// (idempotency: fh_library_add). URLs fetched by one tier are not
// refetched by a later one in the same run. Returns the hit and this run's
// misses; the caller writes both into the entry.

// Attempts are "<tier> (<reason>) <date>". A permanent reason (the paper is
// simply not there) is never retried; a transient one (network, rate limit,
// a wall) is retried once the cooldown has passed, replacing the old entry.
const PERMANENT = /^(no pmcid|no doi|no pmid|no pmid or doi|no body|closed|no oa copy|no free copy|not in core|no full text|xml without body|template has no placeholder|title missing|title not in text|supplementary material|another document|no methods\/results|no article body|scanned pdf|not a pdf|only copies already tried|only pmc copies|nothing located|unknown content|no text-mining links|needs [a-z/]+ token)/i;
// Blocked by policy: a browser challenge not cleared, or Bright Data's "empty
// response" (the target refused it too). Final by default — the same method
// tomorrow ends the same way; FH_RETRY_BLOCKED=true makes them
// transient again, for after a change of method (2026-10-28).
const BLOCKED = /^(challenge not cleared|empty response)/i;
// The stage that produced a download reason ("browser dc-server: …", "zyte: …").
const STAGE = /^((?:playwright|chrome|browser|fetch-proxy) [^:]+|brightdata|firecrawl|zenrows|zyte|unlocker): /;

export function isPermanent(reason: string, retryBlocked = false): boolean {
  // A download tier lists one reason per URL; it is permanent only if every URL's reason is.
  return reason.split(";").every((r) => { const b = r.trim().replace(STAGE, ""); return PERMANENT.test(b) || (!retryBlocked && BLOCKED.test(b)); });
}

export function parseAttempt(a: string): { tier: string; reason: string; date: string | null } | null {
  const m = /^(\S+) \((.*)\)(?: (\d{4}-\d{2}-\d{2}))?$/.exec(a.trim());
  return m ? { tier: m[1], reason: m[2], date: m[3] ?? null } : null;
}

export const attemptLabel = (m: TierMiss, date = new Date().toISOString().slice(0, 10)) => `${m.tier} (${m.reason}) ${date}`;

export function shouldSkip(attempts: string[], tier: string, retryAfterDays: number, now = new Date(), retryBlocked = false): boolean {
  for (const a of attempts) {
    const p = parseAttempt(a);
    if (!p || p.tier !== tier) continue;
    if (isPermanent(p.reason, retryBlocked)) return true;
    if (!p.date) return false;                       // undated transient entry (old format): retry
    const age = (now.getTime() - new Date(p.date).getTime()) / 86_400_000;
    return age < retryAfterDays;
  }
  return false;
}

// Kept for callers/tests that only ask "is this tier listed".
export const attempted = (attempts: string[], tier: string) => attempts.some((a) => parseAttempt(a)?.tier === tier);

export type TierEvent = TierResult | { ok: "try"; tier: string; message: string } | { ok: "alert"; tier: string; message: string };

export async function fulltextCascade(
  p: Paper,
  attempts: string[],
  onEvent?: (e: TierEvent) => void,
  tiers: Tier[] = resolveTiers().tiers,
  retryAfterDays: number = settings().retry_after_days, retryBlocked: boolean = settings().retry_blocked,
): Promise<{ hit: TierHit | null; misses: TierMiss[] }> {
  const misses: TierMiss[] = [];
  const tried = new Set<string>();
  // Every tier's API lookup at once (Europe PMC, Crossref, Unpaywall,
  // OpenAlex: keyless, about a second each), so a tier reached after others
  // missed finds its answer waiting; the downloads stay in tier order. A
  // lookup never awaited (an earlier tier hit) costs one API call.
  // AI4L's log, 2026-11-07/08: the lookups ran one after the other, OpenAlex
  // alone 132 times at ~2 s.
  const lookups = new Map<string, Promise<string>>();
  for (const tier of tiers) {
    if (!tier.lookup || shouldSkip(attempts, tier.name, retryAfterDays, new Date(), retryBlocked) || tier.applies(p) !== true) continue;
    const q = tier.lookup(p); q.catch(() => { /* the tier reports it when it gets there */ });
    lookups.set(tier.name, q);
  }
  for (const tier of tiers) {
    if (shouldSkip(attempts, tier.name, retryAfterDays, new Date(), retryBlocked)) continue;
    const applies = tier.applies(p);
    const ctx: RunContext = { tried, lookups, onTry: (message) => onEvent?.({ ok: "try", tier: tier.name, message }), onAlert: (message) => onEvent?.({ ok: "alert", tier: tier.name, message }) };
    const r: TierResult = applies === true ? await tier.run(p, ctx) : { ...miss(tier.name, applies), skipped: true };
    onEvent?.(r);
    if (r.ok) return { hit: r, misses };
    misses.push(r);
  }
  return { hit: null, misses };
}
