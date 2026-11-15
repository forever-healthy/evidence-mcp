import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./entry.js";
import { FH_EVIDENCE_DIR } from "./layout.js";
import { HOST } from "./log.js";

// What this server process has counted since it started: cache hits and
// misses of fh_verify_claim and fh_fetch_url. Kept in memory and published
// as <library>/.servers/<host>-<pid>.json on every change, so the TUI (which
// cannot reach a stdio server another client owns) sums the files of the
// servers alive on a library instead of reading the log. fh_info reports
// the same numbers for this process (cache).
//
// Who cleans the directory: time. A live server rewrites its file every
// HEARTBEAT_MS; a file older than STALE_MS belongs to a server that is gone —
// killed without its exit handler, a container replaced — and every server
// deletes such files when it starts; the TUI only ignores them (it never
// writes to the library). The exit handler removes the file at once in the
// normal case. So the directory holds the live servers, plus at most 20
// minutes of a dead one.

export type Counter = { hits: number; misses: number };
export type Stats = { host: string; pid: number; package: string; version: string; started: string; verify: Counter; fetch: Counter; search: Counter; pubmed: Counter };   // pubmed: fh_pubmed_fetch_articles, per PMID — hit from disk, miss fetched

const HEARTBEAT_MS = 5 * 60_000, STALE_MS = 20 * 60_000;
let stats: Stats | null = null;
let file: string | null = null;

export function startStats(pkg: { name: string; version: string }, libraryDir = FH_EVIDENCE_DIR): Stats {
  stats = { host: HOST, pid: process.pid, package: pkg.name, version: pkg.version, started: new Date().toISOString(), verify: { hits: 0, misses: 0 }, fetch: { hits: 0, misses: 0 }, search: { hits: 0, misses: 0 }, pubmed: { hits: 0, misses: 0 } };
  file = join(libraryDir, ".servers", `${HOST}-${process.pid}.json`);
  sweep(join(libraryDir, ".servers"));
  publish();
  setInterval(publish, HEARTBEAT_MS).unref();   // the heartbeat: a live server's file is never older than HEARTBEAT_MS
  const stop = () => { try { if (file) unlinkSync(file); } catch { /* gone already */ } };
  process.on("exit", stop);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
  return stats;
}

// Files of servers that stopped heartbeating: removed. Called by every server at start.
export function sweep(dir: string, staleMs = STALE_MS): number {
  let n = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const p = join(dir, name);
    try { if (Date.now() - statSync(p).mtimeMs > staleMs) { unlinkSync(p); n++; } } catch { /* gone meanwhile */ }
  }
  return n;
}

export function bump(kind: "verify" | "fetch" | "search" | "pubmed", hit: boolean, n = 1): void {
  if (!stats) return;
  stats[kind][hit ? "hits" : "misses"] += n;
  publish();
}

export const currentStats = (): Stats | null => stats;

function publish(): void {
  if (!stats || !file) return;
  try { mkdirSync(join(file, ".."), { recursive: true }); writeAtomic(file, JSON.stringify(stats, null, 2) + "\n"); } catch { /* the counters are a courtesy, never a failure */ }
}

// The servers alive on a library: every file under .servers/ younger than
// staleMs (older ones stopped heartbeating: the server is gone).
export function readServers(libraryDir = FH_EVIDENCE_DIR, staleMs = STALE_MS): Stats[] {
  const dir = join(libraryDir, ".servers");
  const out: Stats[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const p = join(dir, name);
    try {
      if (Date.now() - statSync(p).mtimeMs > staleMs) continue;
      out.push(JSON.parse(readFileSync(p, "utf8")) as Stats);
    } catch { /* half-written or gone: skipped */ }
  }
  return out;
}
