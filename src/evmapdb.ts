import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// The evidence map's database (stuff/evmap/architecture.md → The database): one SQLite
// file per EVID, evmap/evmap.db in the EVID's folder. node:sqlite (Node 22.13+) is
// loaded only when an evidence map is created or read, so the server still starts on older
// Node versions with the feature off.
//
// The layout: LAYOUT says which version a database has (stuff/evmap/architecture.md → The database).
// Version 4:
//   meta(key PK, value)              layout, hash (the screening: model, prompt, topic, answer
//                                    fields), model, prompt, topic, updated
//   queries(id PK, query UNIQUE, total, kept, error, searched, round)  every query run for the EVID;
//                                    round: the call that brought it in (1, 2, …), never changed
//   query_hits(query_id → queries.id, pmid → articles.pmid, rank)    which query found which
//                                    article, at which place in PubMed's order
//   articles(pmid PK, title, first_author, year, journal, types,
//            found_by, added, queries, reviews, citations,            how it was found, its signals
//            relevance, population, design, n, outcome, finding, aspect, reason, error,   the screening
//            score, pick)                                            the ranking
//   runs(id PK, started, finished, state, error, report)             one row per call; report: the
//                                    run as JSON (PRISMA flow, citation searching, ranking)
//   view evidence_map                articles not screened off-topic
// The file lives in the EVID's folder as evmap/evmap.db — not an EVID object.
// Articles are added and updated, never removed; a new screening hash clears the screening and
// ranking columns.

export const LAYOUT = 11;   // 5: query_items, item_picks (the server's own discovery, src/items.ts); 6: queries.max_results; 7: item_articles; 8: query_items.grp; 9: items (an item's id, its picks, wide); 10: articles.pick gone (the ranking over the whole map; an older database keeps the column, unused); 11: item_candidates (what the picking saw for an item)
export const DB_DIR = "evmap";
export const DB_NAME = "evmap.db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
const require = createRequire(import.meta.url);

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS queries (id INTEGER PRIMARY KEY, query TEXT UNIQUE NOT NULL, total INTEGER, kept INTEGER, error TEXT, searched TEXT, round INTEGER, max_results INTEGER);
  CREATE TABLE IF NOT EXISTS query_hits (query_id INTEGER NOT NULL REFERENCES queries(id), pmid TEXT NOT NULL, rank INTEGER, PRIMARY KEY (query_id, pmid));
  CREATE INDEX IF NOT EXISTS query_hits_pmid ON query_hits (pmid);
  CREATE TABLE IF NOT EXISTS articles (
    pmid TEXT PRIMARY KEY, title TEXT, first_author TEXT, year INTEGER, journal TEXT, types TEXT,
    found_by TEXT, added TEXT, queries INTEGER, reviews INTEGER, citations INTEGER,
    relevance TEXT, population TEXT, design TEXT, n INTEGER, outcome TEXT, finding TEXT, aspect TEXT, reason TEXT, error TEXT,
    score INTEGER);
  CREATE TABLE IF NOT EXISTS query_items (query TEXT PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL, grp TEXT);
  CREATE TABLE IF NOT EXISTS item_picks (kind TEXT NOT NULL, item TEXT NOT NULL, pmid TEXT NOT NULL, pick INTEGER NOT NULL, PRIMARY KEY (kind, item, pmid));
  CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL, grp TEXT, picks INTEGER, wide INTEGER, UNIQUE (kind, item));
  CREATE TABLE IF NOT EXISTS item_articles (kind TEXT NOT NULL, item TEXT NOT NULL, pmid TEXT NOT NULL, PRIMARY KEY (kind, item, pmid));
  CREATE TABLE IF NOT EXISTS item_candidates (kind TEXT NOT NULL, item TEXT NOT NULL, pmid TEXT NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY (kind, item, pmid));
  CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, started TEXT, finished TEXT, state TEXT, error TEXT, report TEXT);
  CREATE VIEW IF NOT EXISTS evidence_map AS
    SELECT pmid, title, first_author, year, journal, types, score, found_by, added, queries, reviews, citations,
           relevance, population, design, n, outcome, finding, aspect, reason, error
    FROM articles WHERE relevance IS NULL OR relevance != 'off-topic';
`;

export function openDb(dir: string, readonly = false): Db {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => Db };
  const file = join(dir, DB_DIR, DB_NAME);
  if (readonly) { if (!existsSync(file)) return null; return new DatabaseSync(file, { readOnly: true }); }
  mkdirSync(join(dir, DB_DIR), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  // layout 3 had no round: added, its queries in round 1
  if (!db.prepare("PRAGMA table_info(queries)").all().some((c: { name: string }) => c.name === "round")) { db.exec("ALTER TABLE queries ADD COLUMN round INTEGER"); db.exec("UPDATE queries SET round = 1"); }
  // layout 6: how many results a query reads, when it is not the general maximum (an item's query reads PubMed's first few)
  if (!db.prepare("PRAGMA table_info(queries)").all().some((c: { name: string }) => c.name === "max_results")) db.exec("ALTER TABLE queries ADD COLUMN max_results INTEGER");
  // layout 8: an item's group inside its table (a review's section: adverse effect, population to avoid, dosing …)
  if (!db.prepare("PRAGMA table_info(query_items)").all().some((c: { name: string }) => c.name === "grp")) db.exec("ALTER TABLE query_items ADD COLUMN grp TEXT");
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('layout', ?)").run(String(LAYOUT));
  return db;
}

export const metaOf = (db: Db, key: string): string | undefined => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;

export const storedQueries = (db: Db): string[] => db.prepare("SELECT query FROM queries ORDER BY id").all().map((r: { query: string }) => r.query);


export type Rows = { columns: string[]; rows: unknown[][]; total: number };

export function query(db: Db, sql: string, params: (string | number)[], offset: number, limit: number): Rows {
  const stmt = db.prepare(sql.trim().replace(/;\s*$/, ""));
  const all: Record<string, unknown>[] = stmt.all(...params);
  const columns = all.length ? Object.keys(all[0]) : ((stmt.columns?.() ?? []) as { name: string }[]).map((c) => c.name);
  return { columns, rows: all.slice(offset, offset + limit).map((r) => columns.map((c) => r[c] ?? null)), total: all.length };
}

// The latest run's report (parsed), or null.
export function lastRun(db: Db): Record<string, unknown> | null {
  const r = db.prepare("SELECT id, state, error, report FROM runs ORDER BY id DESC LIMIT 1").get() as { id: number; state: string; error: string | null; report: string | null } | undefined;
  if (!r) return null;
  try { return { run: r.id, ...(r.report ? JSON.parse(r.report) : {}), state: r.state, ...(r.error ? { error: r.error } : {}) }; } catch { return { run: r.id, state: r.state }; }
}
