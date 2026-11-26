import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { num } from "./env.js";
import { openEvid } from "./evid.js";
import { DB_DIR } from "./evmapdb.js";
import { HOST, log } from "./log.js";
import { writeAtomic } from "./entry.js";

// Building a map takes minutes (with the server's own discovery about six, 2026-11-22): longer
// than a tool call should wait. So the build is a job: fh_evmap_create_map starts it and answers
// at once — the finished map when it is done within FH_EVMAP_WAIT_SECS, else "running" — and
// fh_evmap_get_map answers the job's state until the map is there:
//   running      — the stage it is at (the build's last log line), the seconds so far
//   done         — the map
//   failed       — the reason
//   interrupted  — running, but no sign of life for STALE_SECS: the server that built it stopped;
//                  fh_evmap_create_map again picks it up (searches and screenings are cached)
// The state is one small file in the EVID, evmap/job.json, rewritten at every stage and every
// HEARTBEAT_SECS: any server on the volume can read it; the job itself lives in the process that
// started it.

export const JOB_FILE = "job.json";
const HEARTBEAT_SECS = 10, STALE_SECS = 60;
export const waitSecs = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_WAIT_SECS", 5, env, (n) => n >= 0 && n <= 600);
export type Job = { state: "running" | "done" | "failed"; stage: string; started: string; updated: string; finished?: string; error?: string; host: string; pid: number };
export type JobView = Omit<Job, "state"> & { state: Job["state"] | "interrupted"; seconds: number };

const fileOf = (lib: string, evid: string): string | null => { const o = openEvid(lib, evid); return o.ok ? join(o.dir, DB_DIR, JOB_FILE) : null; };
const write = (file: string, j: Job) => { try { mkdirSync(join(file, ".."), { recursive: true }); writeAtomic(file, JSON.stringify(j) + "\n"); } catch { /* the state is a courtesy: the build goes on */ } };

// The job of an EVID's map as a reader sees it; null: no job was ever started for it.
export function readJob(lib: string, evid: string, now: Date = new Date()): JobView | null {
  const file = fileOf(lib, evid);
  if (!file || !existsSync(file)) return null;
  let j: Job;
  try { j = JSON.parse(readFileSync(file, "utf8")) as Job; } catch { return null; }
  const end = j.finished ? Date.parse(j.finished) : now.getTime();
  const stale = j.state === "running" && now.getTime() - Date.parse(j.updated) > STALE_SECS * 1000;
  return { ...j, state: stale ? "interrupted" : j.state, seconds: Math.max(0, Math.round((end - Date.parse(j.started)) / 1000)) };
}

const running = new Map<string, Promise<unknown>>();   // this process's jobs, by EVID
export const jobRunning = (evid: string): boolean => running.has(evid);

// Starts the build as a job. run gets `stage` to say where it is; its result ({ ok, error? }) ends
// the job as done or failed. Returns the job's promise (it never rejects).
export function startJob<T extends { ok: boolean; error?: string }>(lib: string, evid: string, run: (stage: (message: string) => void) => Promise<T>): Promise<T | { ok: false; error: string }> {
  const file = fileOf(lib, evid);
  const job: Job = { state: "running", stage: "starting", started: new Date().toISOString(), updated: new Date().toISOString(), host: HOST, pid: process.pid };
  const save = () => { job.updated = new Date().toISOString(); if (file) write(file, job); };
  save();
  const beat = setInterval(save, HEARTBEAT_SECS * 1000);
  beat.unref?.();
  const p = (async () => {
    let r: T | { ok: false; error: string };
    try { r = await run((m) => { job.stage = m; save(); }); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; log("evmap", evid, `failed at "${job.stage}": ${r.error.slice(0, 300)}`); }   // thrown, not returned: nothing else logs it
    clearInterval(beat);
    job.state = r.ok ? "done" : "failed"; job.finished = new Date().toISOString();
    if (!r.ok) job.error = r.error ?? "failed";
    save();
    running.delete(evid);
    return r;
  })();
  running.set(evid, p);
  return p;
}

// What a caller is told about a job that is not done: the tool's answer.
export const jobAnswer = (evid: string, j: JobView): Record<string, unknown> => ({
  evid, state: j.state, stage: j.stage, seconds: j.seconds,
  ...(j.state === "running" ? { next: "the map is being built (several minutes): wait with fh_evmap_get_info, about every 30 seconds, until state is done; then read it with fh_evmap_get_map" } : {}),
  ...(j.state === "interrupted" ? { next: "the server that was building this map stopped; call fh_evmap_create_map again with this evid to go on (what was searched and screened is kept)" } : {}),
  ...(j.state === "failed" ? { error: j.error } : {}),
});
