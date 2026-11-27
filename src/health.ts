import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./entry.js";

// fh_info's paid checks — one request per unlocker, one question to the decision model — are asked at most
// every 15 minutes per library, not on every call: on live fh_info ran 200–440 times a day, each call a request to
// every unlocker (2026-11-27). A check that answered ok is kept in <library>/.health.json, shared by every server
// on the library, and given again with its age (checked_secs_ago); a failed check is never kept, so a fault that
// was fixed shows at the next call.
export const HEALTH_REUSE_SECS = 15 * 60;
type Kept = { ms: number; at: number };
const file = (dir: string) => join(dir, ".health.json");
const read = (dir: string): Record<string, Kept> => { try { return JSON.parse(readFileSync(file(dir), "utf8")) as Record<string, Kept>; } catch { return {}; } };

export type Health = { ok: boolean; ms: number; error: string | null; checked_secs_ago?: number };
export async function recentHealth(dir: string, key: string, check: () => Promise<{ ok: boolean; ms: number; error: string | null }>, now: () => number = Date.now): Promise<Health> {
  const kept = read(dir)[key];
  const age = kept ? (now() - kept.at) / 1000 : Infinity;
  if (kept && age >= 0 && age < HEALTH_REUSE_SECS) return { ok: true, ms: kept.ms, error: null, checked_secs_ago: Math.round(age) };
  const h = await check();
  try {
    const all = read(dir);   // read again: other checks ran meanwhile
    if (h.ok) all[key] = { ms: h.ms, at: now() }; else delete all[key];
    writeAtomic(file(dir), JSON.stringify(all) + "\n");
  } catch { /* the next call asks again */ }
  return h;
}
