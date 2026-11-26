import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { num } from "./env.js";
import { FH_EVIDENCE_DIR } from "./layout.js";

// One append-only log for the whole library: <library>/logs/evidence.log (in its
// own folder since 2026-11-13, with its rotated .1 beside it). Every tool
// call writes one line per action. The line starts with the host, so that
// several workers (a batch of review workers) writing to one mounted library can be told
// apart. Appends are small single writes, which the OS keeps intact across
// processes.
//
//   2026-10-26 17:04:11 mig fh_library_add pmid:30955454 fetched pubmed level=abstract
//
// Local time (one log per library, read by a person), host as plain word.

export const HOST = hostname();
// Who made the call, in every log line: FH_CLIENT_NAME (a project's name, when several projects share a
// library on one machine), else the host name. Read at the first line, after the .env is loaded.
let client: string | undefined;
export const clientName = (env: NodeJS.ProcessEnv = process.env): string => (env.FH_CLIENT_NAME ?? "").trim().replace(/\s+/g, "-") || HOST;
export const LOG_DIR = join(FH_EVIDENCE_DIR, "logs");
export const LOG_FILE = join(LOG_DIR, "evidence.log");

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Rotation (#14): past LOG_MAX_BYTES the log is renamed to a dated file beside it,
// logs/evidence-YYYY-MM-DD-HHMMSS.log (sorted by time), and the next append
// recreates it. At each rotation, rotated logs older than FH_LOG_KEEP_DAYS
// (default 7) are deleted — so the history is a fixed span of days, whatever the
// traffic (2026-11-13; before, one <log>.1 was kept). The server is the writer, so
// this works with or without the TUI. No coordination between processes: the
// rename is atomic; two servers crossing the limit in one second get distinct names.
// 5 MB (2026-11-13, was 50 MB): about 25,000 lines, hours on a busy fleet; the TUI
// reads the whole log at its start and parses every line (#67).
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const DAY_MS = 86_400_000;
const stampOf = (t: Date) => { const p = (n: number) => String(n).padStart(2, "0"); return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`; };
// A free dated name for a rotated log in the log's folder.
function datedName(file: string, when: Date): string {
  const base = join(dirname(file), `${basename(file, ".log")}-${stampOf(when)}`);
  let name = `${base}.log`;
  for (let n = 2; existsSync(name); n++) name = `${base}-${n}.log`;
  return name;
}
export function rotateIfLarge(file: string, max = LOG_MAX_BYTES, keepDays = num("FH_LOG_KEEP_DAYS", 7)): boolean {
  let size = 0;
  try { size = statSync(file).size; } catch { return false; }
  if (size <= max) return false;
  let moved = false;
  try { renameSync(file, datedName(file, new Date())); moved = true; } catch { /* another server rotated it */ }
  pruneLogs(file, keepDays);
  return moved;
}
// Rotated logs older than keepDays go; a <log>.1 from before dated names gets its
// date from its last change first, so it is kept or pruned like the others.
export function pruneLogs(file: string, keepDays: number, now = Date.now()): void {
  const dir = dirname(file), stem = basename(file, ".log");
  try {
    const old1 = `${file}.1`;
    if (existsSync(old1)) renameSync(old1, datedName(file, statSync(old1).mtime));
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`${stem}-`) || !f.endsWith(".log")) continue;
      const path = join(dir, f);
      if (now - statSync(path).mtimeMs > keepDays * DAY_MS) unlinkSync(path);
    }
  } catch { /* logging never fails a call */ }
}

// Where the log was before: <library>/library.log (before the rename to
// evidence-mcp), then <library>/evidence.log (until 2026-11-13). Moved once, at
// startup, with the rotated .1, into logs/, so the history carries over. Only
// while the new file does not exist — a server that started first has moved it.
export function migrateLogName(dir = FH_EVIDENCE_DIR): void {
  const logs = join(dir, "logs");
  for (const [from, to] of [["evidence.log", "evidence.log"], ["evidence.log.1", "evidence.log.1"], ["library.log", "evidence.log"], ["library.log.1", "evidence.log.1"]]) {
    const a = join(dir, from), b = join(logs, to);
    if (existsSync(a) && !existsSync(b)) {
      try { mkdirSync(logs, { recursive: true }); renameSync(a, b); } catch { /* another server moved it */ }
    }
  }
}

export function log(tool: string, id: string | null, message: string): void {
  // One line per action, whatever the message contained (newlines, ANSI codes).
  // URLs without "https://" — nearly every URL has it, so it is only bytes; a plain
  // "http://" stays, it is the exception (an old link). The TUI puts https:// back for links.
  const clean = message.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s*\n\s*/g, " | ").replace(/https:\/\//g, "");
  const line = `${stamp()} ${(client ??= clientName())} ${tool} ${(id ?? "-").replace(/https:\/\//g, "")} ${clean}\n`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    rotateIfLarge(LOG_FILE);
    appendFileSync(LOG_FILE, line);
  } catch {
    // Logging never fails a call.
  }
}
