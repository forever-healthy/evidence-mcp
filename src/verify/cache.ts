import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { settings } from "../config.js";
import { daysSince, today, writeAtomic } from "../entry.js";
import { FH_EVIDENCE_DIR } from "../layout.js";
import type { VerifyConfig } from "./config.js";
import type { Decide } from "./decider.js";
import { readPaper, verifyClaim, type Paper, type VerifyResult } from "./verify.js";

// Verdicts are kept: the same claim against the same stored text answers from
// disk, so an audit that runs twice over one review pays the model once.
//
// Store: the file system as the database — verify/<h2>/<h4>/<key>.json, one
// file per judgement, laid out like url/ (src/layout.ts,
// layout"). A lookup is one stat, a write is one atomic rename, nothing is
// parsed but the one file; node:sqlite would need Node 22.13 where the
// package promises 18, and better-sqlite3 a native build for every npx user.
//
// Key: the first 16 hex digits of the SHA-1 of the folded claim, the source
// ID, the model, the threshold and a hash of the stored text. Folding (#33)
// removes typography only — NFKC, case, whitespace runs and non-breaking
// spaces, curly quotes and apostrophes, en/em dashes and the minus sign, "+/-"
// for "±", a trailing period — never a word: a reordered or reworded claim is
// another statement and may earn another verdict. The claim is judged and
// stored as written. A paper that gains its full text or a refreshed record
// changes the text hash, so the old verdict misses by itself; a different
// model or threshold is a different judgement. The file names the source and
// the claim, for a human reading it.
//
// Kept: results with a model score (supported, not_supported, unverifiable). Never
// kept: an error, or the title-only not_supported that needs no model. Expiry: the same
// FH_REFRESH_AFTER_DAYS as pages. The result JSON the model receives
// is identical either way; the cache shows in the log line ("cached").
//
// Several servers share one library (evidence-mcp, -dev and -local on one
// checkout; the auditor's parallel calls): a file appears whole or not at all
// (written to a temp name, renamed), so there is nothing to lock. Two
// instances that miss at once both write; the later rename wins, same content.

export type Cached = {
  key: string; id: string; claim: string; model: string; threshold: number; text: string; date: string;
  verdict: VerifyResult["verdict"]; reason: string | null; score: number; basis: VerifyResult["basis"];
  windows: number; glyphs_unresolved: number; superseded: boolean | null;
};

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
export const normalizeClaim = (claim: string) => claim.replace(/\s+/g, " ").trim();
export function foldClaim(claim: string): string {
  return claim.normalize("NFKC").toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'").replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\+\/-|\+-/g, "±")
    .replace(/\s+/g, " ").trim().replace(/[.;:,]+$/, "").trim();
}
export const textHash = (text: string) => sha(text).slice(0, 16);
// v2: verdicts supported / not_supported (2026-11-19); judgements stored under the old key are never read again.
// v3: a not_supported next to a lost PDF symbol is decided again (2026-11-23, #95).
export const cacheKey = (claim: string, id: string, model: string, threshold: number, text: string) => sha(`v3\n${foldClaim(claim)}\n${id}\n${model}\n${threshold}\n${text}`).slice(0, 16);

export const verdictFile = (libraryDir: string, key: string) => join(libraryDir, "verify", key.slice(0, 2), key.slice(0, 4), `${key}.json`);

export function readVerdict(file: string): Cached | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as Cached; } catch { return null; }   // half a file is no file
}

// The judgement under this key, when younger than maxDays.
export function lookup(file: string, maxDays: number): Cached | null {
  const c = readVerdict(file);
  return c && daysSince(c.date) < maxDays ? c : null;
}

export function remember(file: string, c: Cached): void {
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(c, null, 2) + "\n");
}

export type CachedResult = VerifyResult & { cached: boolean };

// verifyClaim with the cache in front: the paper is read once, here; a hit
// answers from disk, a miss runs the model and keeps what it said.
export async function verifyCached(claim: string, id: string, cfg: VerifyConfig | null, decide: Decide | null, libraryDir = FH_EVIDENCE_DIR, read: (id: string, libraryDir: string) => Paper | Promise<Paper> = readPaper): Promise<CachedResult> {
  const paper = await read(id, libraryDir);
  const once = () => paper;
  if ("error" in paper || !cfg) return { ...(await verifyClaim(claim, id, cfg, decide, once)), cached: false };
  const text = textHash(paper.text);
  const file = verdictFile(libraryDir, cacheKey(claim, paper.id, cfg.model, cfg.threshold, text));
  const hit = lookup(file, settings().refresh_after_days);
  if (hit) {
    return { claim, id: paper.id, verdict: hit.verdict, reason: hit.reason, score: hit.score, basis: hit.basis, windows: hit.windows, glyphs_unresolved: hit.glyphs_unresolved, superseded: hit.superseded, model: hit.model, cached: true };
  }
  const r = await verifyClaim(claim, id, cfg, decide, once);
  if (!r.error && r.score !== null) {
    remember(file, { key: file.slice(-21, -5), id: paper.id, claim: normalizeClaim(claim), model: cfg.model, threshold: cfg.threshold, text, date: today(), verdict: r.verdict, reason: r.reason, score: r.score, basis: r.basis, windows: r.windows, glyphs_unresolved: r.glyphs_unresolved, superseded: r.superseded });
  }
  return { ...r, cached: false };
}
