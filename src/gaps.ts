import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openEvid } from "./evid.js";
import { openDb, query } from "./evmapdb.js";
import { HOST } from "./log.js";
import { itemRows, shownAspects } from "./items.js";

// Map gaps: an article an auditor (or the model that writes a review) is about to add to the review and
// that the map did not give — reported with its PMID, the section it goes in and the aspect it backs.
// fh_evmap_report_gap stores the report and says at once
// what the map knows about it; fh_evmap_get_gaps reads the reports back. One SQLite database for
// the whole library, <library>/evmap/gaps.db: every server on the volume writes to it, and the
// map's developers read the misses of a live system in one place, with no server log to search.
// The class of a reported paper names the part of the map to look at:
//   not found            — no query found it                          → discovery
//   screened off-topic   — a query found it, the screening dropped it → screening
//   not picked           — in the map, picked for no aspect           → ranking
//   picked               — it is in an item's top: no gap, the report says which item
// instead: what the map has in the gap's place — a best guess, made without a model: the items
// the reported paper was found for or assigned to, and the items whose name shares a word with
// the reported item, each with its picked articles. An auditor may find the claim already backed
// there and need no new paper.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
const require = createRequire(import.meta.url);
export const GAPS_DIR = "evmap", GAPS_DB = "gaps.db";
export const GAP_COLUMNS = ["id", "reported", "host", "evid", "topic", "pmid", "aspect", "section", "reason", "class", "detail"] as const;
export type GapClass = "not found" | "screened off-topic" | "not picked" | "picked";

function open(lib: string, readonly = false): Db {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => Db };
  const file = join(lib, GAPS_DIR, GAPS_DB);
  if (readonly) return existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
  mkdirSync(join(lib, GAPS_DIR), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS gaps (id INTEGER PRIMARY KEY, reported TEXT NOT NULL, host TEXT, evid TEXT NOT NULL, topic TEXT, pmid TEXT, item TEXT, kind TEXT, reason TEXT, class TEXT NOT NULL, detail TEXT)");
  return db;
}

export type GapReport = { evid: string; pmid: string; item: string; kind: string; reason?: string };
export type Instead = { id?: number; section: string; aspect: string; pmids: string[] };
export type GapAnswer = { ok: true; id: number; class: GapClass; detail: string; instead?: Instead[] } | { ok: false; error: string };

// What the map knows about a paper.
function classify(map: Db, pmid: string): { class: GapClass; detail: string } {
  const a = map.prepare("SELECT relevance, reason, title FROM articles WHERE pmid = ?").get(pmid) as { relevance: string | null; reason: string | null; title: string | null } | undefined;
  if (!a) return { class: "not found", detail: "no query of the map found this article" };
  const by = (map.prepare("SELECT q.query FROM query_hits h JOIN queries q ON q.id = h.query_id WHERE h.pmid = ? ORDER BY q.id").all(pmid) as { query: string }[]).map((x) => x.query);
  const hasItems = !!map.prepare("SELECT name FROM sqlite_master WHERE name = 'item_picks'").get();
  const shown = new Set(hasItems ? shownAspects(map as never).map((x) => `${x.kind}: ${x.item}`) : []);   // an aspect without an article is named nowhere
  const itemsOf = hasItems ? (map.prepare("SELECT DISTINCT i.kind || ': ' || i.item AS it FROM query_hits h JOIN queries q ON q.id = h.query_id JOIN query_items i ON i.query = q.query WHERE h.pmid = ?").all(pmid) as { it: string }[]).map((x) => x.it).filter((it) => shown.has(it)) : [];
  if (a.relevance === "off-topic") return { class: "screened off-topic", detail: `found by ${by.length} quer${by.length === 1 ? "y" : "ies"}${itemsOf.length ? ` (${itemsOf.join("; ")})` : ""}; the screening: ${a.reason ?? "no reason stored"}` };
  const picked = hasItems ? (map.prepare("SELECT kind || ': ' || item AS it, pick FROM item_picks WHERE pmid = ? ORDER BY pick").all(pmid) as { it: string; pick: number }[]) : [];
  if (picked.length) return { class: "picked", detail: `the map has it: ${picked.map((p) => `${p.it} (pick ${p.pick})`).join("; ")}` };
  return { class: "not picked", detail: `in the map, picked for no aspect${itemsOf.length ? `; found for ${itemsOf.join("; ")}` : by.length ? `; found by ${by.length} quer${by.length === 1 ? "y" : "ies"}` : "; from a review's reference list"}` };
}

// The map's items that may stand in for a gap, each with its picks: at most three, the best match first.
const STOP = new Set(["with", "from", "risk", "risks", "benefit", "interaction", "effect", "effects", "lower", "higher", "fewer", "more", "less", "other", "increased", "reduced", "improved", "possible", "group"]);
const words = (t: string) => [...new Set((t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)))];
function instead(map: Db, pmid?: string, item?: string, kind?: string): Instead[] {
  if (!map.prepare("SELECT name FROM sqlite_master WHERE name = 'item_picks'").get()) return [];
  const score = new Map<string, number>();
  const all = shownAspects(map as never);
  const wide = new Set(all.filter((x) => x.wide).map((x) => x.kind));   // a table that is one item (the systematic reviews) covers no single claim
  const key = (x: { kind: string; item: string }) => `${x.kind}\u0000${x.item}`;
  if (item) { const w = words(item); for (const x of all) { if (kind && x.kind.toLowerCase() !== kind.toLowerCase()) continue; const n = words(x.item).filter((y) => w.includes(y)).length; if (n) score.set(key(x), n * 10); } }
  if (pmid) {
    const of = map.prepare("SELECT DISTINCT i.kind, i.item FROM query_hits h JOIN queries q ON q.id = h.query_id JOIN query_items i ON i.query = q.query WHERE h.pmid = ?").all(pmid) as { kind: string; item: string }[];
    if (map.prepare("SELECT name FROM sqlite_master WHERE name = 'item_articles'").get()) of.push(...(map.prepare("SELECT kind, item FROM item_articles WHERE pmid = ?").all(pmid) as { kind: string; item: string }[]));
    for (const x of of) if (!wide.has(x.kind)) score.set(key(x), (score.get(key(x)) ?? 0) + 5);
  }
  const out: Instead[] = [];
  // only the best matches: an item that shares fewer words than the best one is noise ("blood glucose" for "blood pressure")
  const top = Math.max(0, ...score.values());
  for (const [k] of [...score].filter((x) => x[1] >= top).sort((a, b) => b[1] - a[1])) {
    const [kd, it] = k.split("\u0000");
    const pmids = (map.prepare("SELECT pmid FROM item_picks WHERE kind = ? AND item = ? ORDER BY pick").all(kd, it) as { pmid: string }[]).map((a) => a.pmid).filter((p) => p !== pmid);
    if (pmids.length) out.push({ id: all.find((x) => x.kind === kd && x.item === it)?.id, section: kd, aspect: it, pmids });
    if (out.length === 3) break;
  }
  return out;
}

export function reportGap(lib: string, r: GapReport, now: Date = new Date()): GapAnswer {
  const o = openEvid(lib, r.evid);
  if (!o.ok) return o;
  // a gap is an article the map did not give: the article, the section it goes in and the aspect it backs
  const pmid = r.pmid?.replace(/^pmid:/i, "").trim() ?? "", item = r.item?.trim() ?? "";
  const lacks = [!pmid && "pmid", !r.kind?.trim() && "section", !item && "aspect"].filter(Boolean);
  if (lacks.length) return { ok: false, error: `give pmid (the article you would add), section and aspect (what it backs) — missing: ${lacks.join(", ")}` };
  if (!/^\d{1,8}$/.test(pmid)) return { ok: false, error: `invalid pmid '${r.pmid}'` };
  const map = openDb(o.dir, true);
  if (!map) return { ok: false, error: `${o.evid}: no evidence map yet` };
  // the section as the map names it (case ignored); one the map does not have is refused, not stored
  {
    let declared: string[] = [];
    try { declared = JSON.parse((map.prepare("SELECT value FROM meta WHERE key = 'sections'").get() as { value: string } | undefined)?.value ?? "[]") as string[]; } catch { /* none stored */ }
    const names = [...new Set([...declared, ...itemRows(map as never).map((x) => x.kind)])];
    const hit = names.find((n) => n.toLowerCase() === r.kind.trim().toLowerCase());
    if (!hit && names.length) { map.close(); return { ok: false, error: `no section "${r.kind.trim()}" in this map — its sections: ${names.join(", ")}` }; }
    r = { ...r, kind: hit ?? r.kind.trim() };
  }
  let c: { class: GapClass; detail: string }, topic = "", alt: Instead[] = [];
  try {
    topic = (map.prepare("SELECT value FROM meta WHERE key = 'topic'").get() as { value: string } | undefined)?.value ?? "";
    c = classify(map, pmid);
    if (c.class !== "picked") alt = instead(map, pmid, item, r.kind);
  } finally { map.close(); }
  const db = open(lib);
  try {
    const id = Number((db.prepare("INSERT INTO gaps (reported, host, evid, topic, pmid, item, kind, reason, class, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id").get(now.toISOString(), HOST, o.evid, topic, pmid, item, r.kind, r.reason?.trim() || null, c.class, c.detail) as { id: number }).id);
    return { ok: true, id, class: c.class, detail: c.detail, ...(alt.length ? { instead: alt } : {}) };
  } finally { db.close(); }
}

// The reports, newest first, and how many of each class (over the same filter, before the limit).
export function getGaps(lib: string, f: { since?: string; evid?: string; class?: string; limit?: number } = {}): { counts: Record<string, number>; columns: readonly string[]; rows: unknown[][]; total: number } {
  const db = open(lib, true);
  if (!db) return { counts: {}, columns: GAP_COLUMNS, rows: [], total: 0 };
  try {
    const where: string[] = [], params: (string | number)[] = [];
    if (f.since) { where.push("reported >= ?"); params.push(f.since); }
    if (f.evid) { where.push("evid = ?"); params.push(f.evid.startsWith("evid:") ? f.evid : `evid:${f.evid}`); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const counts = Object.fromEntries((db.prepare(`SELECT class, COUNT(*) AS n FROM gaps ${w} GROUP BY class ORDER BY n DESC`).all(...params) as { class: string; n: number }[]).map((x) => [x.class, x.n]));
    const w2 = f.class ? `${w ? `${w} AND` : "WHERE"} class = ?` : w;
    const r = query(db, `SELECT ${GAP_COLUMNS.map((c) => (c === "section" ? "kind AS section" : c === "aspect" ? "item AS aspect" : c)).join(", ")} FROM gaps ${w2} ORDER BY id DESC`, f.class ? [...params, f.class] : params, 0, Math.min(1000, Math.max(1, f.limit ?? 100)));
    return { counts, columns: GAP_COLUMNS, rows: r.rows, total: r.total };
  } finally { db.close(); }
}
