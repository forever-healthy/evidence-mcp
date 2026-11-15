import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { daysSince, now, writeAtomic } from "./entry.js";
import type { EntryPaths } from "./layout.js";

// An ID no service knows — a PMID PubMed has no record for, a DOI neither
// Crossref nor doi.org resolves, a set ID DailyMed has no label for, an NCT ID
// ClinicalTrials.gov has no study for — is remembered for
// FH_RETRY_AFTER_DAYS in a marker file in the entry's directory:
// <entry>-missing.md with the date and the reason. Within that time every tool
// answers "not found" from disk; after it the service is asked again, so an
// ID that appears later is picked up. The same cooldown a failed page or a
// transient tier failure gets. No meta file: fh_info and the TUI count
// nothing. writeMeta removes the marker the moment a real entry is written.
// A network error is not "not found" and is never remembered.

export type Missing = { checked: string; reason: string };

export const missingFile = (p: EntryPaths) => join(p.entryDir, `${p.entry}-missing.md`);

export function readMissing(p: EntryPaths): Missing | null {
  const f = missingFile(p);
  if (!existsSync(f)) return null;
  const md = readFileSync(f, "utf8");
  const get = (k: string) => /^$/.test(k) ? "" : (new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(md)?.[1] ?? "").trim();
  const checked = get("checked"), reason = get("reason");
  return checked ? { checked, reason: reason || "not found" } : null;
}

// The marker when it is still within the cooldown; null when absent or due for another ask.
export function freshMissing(p: EntryPaths, retryDays: number): Missing | null {
  const m = readMissing(p);
  return m && daysSince(m.checked) < retryDays ? m : null;
}

export function rememberMissing(p: EntryPaths, reason: string): Missing {
  const m = { checked: now(), reason };
  mkdirSync(p.entryDir, { recursive: true });
  writeAtomic(missingFile(p), `checked: ${m.checked}\nreason: ${m.reason}\n`);
  return m;
}

// The error text a tool answers from the marker.
export const missingNote = (m: Missing, retryDays: number) => `${m.reason} (checked ${m.checked.slice(0, 10)}; asked again after ${retryDays} day${retryDays === 1 ? "" : "s"})`;
