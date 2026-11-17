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

// Bright Data's refusal of the page for robots.txt or a captcha ("challenge not cleared (captcha)") is a wall too
// (live 2026-11-13–15: Wiley 31 refusals, each try a paid request and an alert until 1.0.1).
// Zyte's "HTTP 520 Website Ban" likewise, after the first one (live: Wiley 48 bans, SAGE 30, 0 ok).
// A timeout on the page too — an unlocker's ("timeout", "The operation was aborted due to timeout"),
// the fetch proxy's, a browser's page load ("navigation: page.goto: Timeout 20000ms"); not a browser
// server's connect timeout, which is our own host (src/hosts.ts). Live 2026-11-07–15: after a ZenRows
// timeout the next on the same site timed out too 92 times in 100 (Wiley 48, SAGE 30, Europe PMC
// 15 — none ever ok), the fetch proxy's 74, Chrome's 84; Bright Data's alternate with successes
// (Europe PMC 4 timeouts, 8 ok), which two in a row and a success clearing it allow for.
const TIMEOUT = "timeout\\b|The operation was aborted due to timeout|navigation: page\\.goto: Timeout \\d+ms";
// The Bright Data words before 1.0.1 ("page refused: …") still match, for walls stored with them.
const WALL = new RegExp(`^(challenge not cleared|empty response|HTTP 520 Website Ban|robots\\.txt restricts|page refused: .*(robots\\.txt|captcha|protection page|: 403)|${TIMEOUT})`, "i");
// A robots.txt refusal is a rule for some paths, not the site (Wiley and SAGE refuse only their
// /doi/full-xml/ mining endpoint, whose sign-in redirect robots.txt restricts; their open PDFs
// are not affected): recorded under the stage and the URL's first two path segments,
// "brightdata /doi/full-xml". Every other wall stays per site: a browser challenge covers the
// whole site (live 2026-11-07–15: core.ac.uk 31 walls on 15 papers, 0 ok; OUP 26 on 11, 0 ok) —
// per path it would cost two tries a paper instead of two a site.
const ROBOTS = /^(robots\.txt restricts|page refused: .*robots\.txt)/i;
// A rule, not chance — the service says it will not fetch this: a wall after the first refusal.
// Judged by the stored reason, so a streak of one recorded before this rule counts too.
const RULE = /^(HTTP 520 Website Ban|robots\.txt restricts|page refused: .*robots\.txt)/i;
const pathKey = (url: string, stage: string) => {
  try { return `${stage} /${new URL(url).pathname.split("/").filter(Boolean).slice(0, 2).join("/")}`; } catch { return stage; }
};
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
  const live = (r?: Rec) => r && (r.streak >= WALL_STREAK || RULE.test(r.reason)) && daysSince(r.date) < settings().retry_after_days ? r : null;
  return live(all[stage] ?? all[legacy(stage)])   // a wall recorded under the old name "browser <label>" still counts
    ?? live(all[pathKey(url, stage)]);
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
  const pk = pathKey(url, stage);
  if (ok) { if (!all[stage] && !all[pk]) return; delete all[stage]; delete all[pk]; }
  else if (ROBOTS.test(why)) all[pk] = { streak: (all[pk]?.streak ?? 0) + 1, date: now(), reason: why };
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
