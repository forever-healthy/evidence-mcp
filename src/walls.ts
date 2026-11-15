import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { settings } from "./config.js";
import { daysSince, now, writeAtomic } from "./entry.js";
import { FH_EVIDENCE_DIR } from "./layout.js";

// Walls per host and stage: a browser stage (or Bright Data) that met the same
// host's wall twice in a row is skipped for that host until
// FH_RETRY_AFTER_DAYS have passed since the last wall; a success
// clears it. Measured on AI4L's library log (2026-11-07/08): a stage that
// failed a host's challenge failed it again every time — Wiley 9 of 9 on
// dc-server, NEJM 5 of 5 on both Playwright servers, SAGE, CORE, OUP, DOAJ
// alike — at 10–20 s a try; Europe PMC alone alternated (3 challenges, 4
// successes on dc-server), hence two in a row, not one.
//
// One file per host under .walls/ (walls/ until 2026-11-13: bookkeeping, hidden like .servers and .browser), {"<stage>": {"streak": n, "date": "…", "reason": "…"}};
// written atomically, last writer wins — a lost streak count only costs a try.

const WALL = /^(challenge not cleared|empty response)/i;
export const WALL_STREAK = 2;

type Rec = { streak: number; date: string; reason: string };
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const file = (dir: string, h: string) => join(dir, ".walls", `${h.replace(/[^a-z0-9.-]/g, "_")}.json`);

// The name a browser stage had before 0.2.24: "playwright dc-server" was "browser dc-server".
const legacy = (stage: string) => stage.replace(/^(playwright|chrome) /, "browser ");

function read(dir: string, h: string): Record<string, Rec> {
  try { return JSON.parse(readFileSync(file(dir, h), "utf8")); } catch { return {}; }
}

// The wall that makes this stage skip this URL's host, or null.
export function walled(url: string, stage: string, dir = FH_EVIDENCE_DIR): Rec | null {
  const h = host(url); if (!h) return null;
  const all = read(dir, h);
  const r = all[stage] ?? all[legacy(stage)];   // a wall recorded under the old name "browser <label>" still counts
  return r && r.streak >= WALL_STREAK && daysSince(r.date) < settings().retry_after_days ? r : null;
}

// After a stage ran: a wall extends the streak, a success clears it, any other
// failure (a 404, no article body) says nothing about the wall and is left out.
export function recordStage(url: string, stage: string, ok: boolean, reason = "", dir = FH_EVIDENCE_DIR): void {
  const h = host(url); if (!h) return;
  const why = reason.replace(/^((?:playwright|chrome|browser|fetch-proxy) [^:]+|brightdata|zenrows|zyte): /, "");
  if (!ok && !WALL.test(why)) return;
  const all = read(dir, h);
  const lk = legacy(stage);
  if (lk !== stage && all[lk]) { all[stage] ??= all[lk]; delete all[lk]; }   // a wall under the old name moves to the new one
  if (ok) { if (!all[stage]) return; delete all[stage]; }
  else all[stage] = { streak: (all[stage]?.streak ?? 0) + 1, date: now(), reason: why };
  try { mkdirSync(join(dir, ".walls"), { recursive: true }); writeAtomic(file(dir, h), JSON.stringify(all) + "\n"); } catch { /* a courtesy */ }
}

export const wallNote = (r: Rec) => `${r.reason} ${r.streak}× on this host, last ${r.date.slice(0, 10)}`;

// The wall memory was <library>/walls/ until 2026-11-13: moved once, at startup,
// to .walls/ (only while .walls/ does not exist — a server that started first moved it).
export function migrateWalls(dir = FH_EVIDENCE_DIR): void {
  const a = join(dir, "walls"), b = join(dir, ".walls");
  if (existsSync(a) && !existsSync(b)) { try { renameSync(a, b); } catch { /* another server moved it */ } }
}
