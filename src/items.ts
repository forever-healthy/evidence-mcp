import { num } from "./env.js";
import { evidDir } from "./evid.js";
import { metaOf, openDb, query } from "./evmapdb.js";
import { activePrompt, builtinPrompt, promptStep } from "./prompts.js";
import { askJson, rankConfig } from "./rank.js";

// The map's items (the server's own discovery, src/discovery.ts): every query of the discovery
// is one question about the intervention — a benefit, a risk, an interaction, a protocol question —
// and the top of the map is picked per item, not from one table over everything: an audit finds
// a paper because it asks one narrow question and reads the top of that answer. For each item the
// ranking model sees the item's best-scored articles and picks the few a review needs for it
// (evmap/ranking.md, step Items). Any of an item's papers backs it: they are interchangeable.
// Bench 2026-11-22, Vitamin C: 20 of the 53 papers the audits added in 201 rows, against 10 in the
// one table's 100 (stuff/evmap/ranking/ranking.md).
//
//
// An item's candidates are not only the results of its own query. That query reads PubMed's first
// few results, and the article a review rests on often came in through another query: its title
// lacks the item's words, or it is a broad article behind a narrow item. So before the picking the
// ranking model gets the list of items and the map's best-scored articles and names the items each
// article belongs to (evmap/ranking.md, step Assign); the picking sees both. Five reviews,
// 2026-11-22: of the review's better articles that were in the map, 2 were among the item's own
// results and all the others under another query (stuff/evmap/ranking/ranking.md).
//
// Tables: query_items — a query's item and kind; item_picks — an item's picked articles, in order
// (layout 5); item_articles — the articles assigned to an item from the whole map (layout 7); item_candidates —
// the articles the picking saw for an item, in the order shown (layout 11): what it saw and did not pick stays
// in the item's answer, behind the picks and the assigned (ten reviews, 2026-11-25: of 92 cited articles the picking
// passed over, 41 were in no answer, #101).
// Several queries may share an item (a query split by an iteration).

// An item: its id (a plain key, given when the map is built and never changed — a map is built once), its table
// (kind) and group as the discovery prompt in force named them (src/tables.ts), how many articles are picked for
// it (none: FH_EVMAP_RANKING_ITEM_PICKS), and wide: the item is a whole table (the systematic reviews) — more
// candidates, and no articles assigned from the rest of the map.
export type QueryItem = { query: string; kind: string; item: string; group?: string; picks?: number; wide?: boolean };
type ItemRow = { id: number; kind: string; item: string; grp: string | null; picks: number | null; wide: number | null };
// A map's items in their order. A map built before layout 9 has no items table: its items are numbered through
// in the order of the five tables it was built with.
const LEGACY_ORDER = `CASE kind ${["review", "benefit", "risk", "interaction", "protocol"].map((k, i) => `WHEN '${k}' THEN ${i}`).join(" ")} ELSE 9 END, MIN(rowid)`;
type Db = NonNullable<ReturnType<typeof openDb>>;
export function itemRows(db: Db): ItemRow[] {
  const has = (t: string) => !!db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(t);
  if (has("items")) { const r = db.prepare("SELECT id, kind, item, grp, picks, wide FROM items ORDER BY id").all() as ItemRow[]; if (r.length) return r; }
  if (!has("query_items")) return [];
  const grp = db.prepare("PRAGMA table_info(query_items)").all().some((c: { name: string }) => c.name === "grp") ? "MIN(grp)" : "NULL";   // a map built before layout 8 has no groups
  return (db.prepare(`SELECT kind, item, ${grp} AS grp FROM query_items GROUP BY kind, item ORDER BY ${LEGACY_ORDER}`).all() as { kind: string; item: string; grp: string | null }[]).map((x, i) => ({ id: i + 1, ...x, picks: x.kind === "review" ? 5 : null, wide: x.kind === "review" ? 1 : 0 }));
}
export const itemCandidates = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_RANKING_ITEM_CANDIDATES", 20, env, (n) => n >= 3 && n <= 100 && Number.isInteger(n));
export const itemPicks = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_RANKING_ITEM_PICKS", 5, env, (n) => n >= 1 && n <= 10 && Number.isInteger(n));
// How many of the map's best-scored articles are assigned to items (0: none; the picking then sees an item's own results only).
export const assignArticles = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_RANKING_ASSIGN_ARTICLES", 300, env, (n) => n >= 0 && n <= 2000 && Number.isInteger(n));
const PER_CALL = 10, CALLS_AT_ONCE = 3, ASSIGN_PER_CALL = 50;

export const ITEMS_PROMPT = promptStep(builtinPrompt("ranking"), "items")!;
export const ASSIGN_PROMPT = promptStep(builtinPrompt("ranking"), "assign")!;
const ASSIGN_SCHEMA = { type: "object", properties: { articles: { type: "array", items: { type: "object", properties: { article: { type: "integer" }, items: { type: "array", items: { type: "integer" } } }, required: ["article", "items"], additionalProperties: false } } }, required: ["articles"], additionalProperties: false } as const;
// The section of the systematic reviews takes only what PubMed's publication type or the title calls one: the
// screening's design alone is not enough (it has called a narrative review with a literature search systematic).
const SR_SECTION = /systematic review|meta-analy/i, SR = /meta-analy|systematic (literature )?review|scoping review|umbrella review/i;
const SCHEMA = { type: "object", properties: { groups: { type: "array", items: { type: "object", properties: { group: { type: "integer" }, picks: { type: "array", items: { type: "integer" } } }, required: ["group", "picks"], additionalProperties: false } } }, required: ["groups"], additionalProperties: false } as const;

// Which item each query asks about; a query sent again keeps its first item.
export function setItems(lib: string, evid: string, items: QueryItem[], sections?: string[]): void {
  const db = openDb(evidDir(lib, evid.replace(/^evid:/, "")));
  try {
    // the sections the map was built for, also those it found no aspect for: asked for, such a section answers "none found", not "no such section"
    if (sections?.length) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('sections', ?)").run(JSON.stringify(sections));
    const up = db.prepare("INSERT INTO query_items (query, kind, item, grp) VALUES (?, ?, ?, ?) ON CONFLICT(query) DO NOTHING");
    const it = db.prepare("INSERT INTO items (kind, item, grp, picks, wide) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, item) DO NOTHING");
    for (const q of items) {
      const kind = q.kind.trim() || "other", item = q.item.trim() || "(unnamed)", grp = q.group?.trim() || null;
      if (Number(up.run(q.query.replace(/\s+/g, " ").trim(), kind, item, grp).changes)) it.run(kind, item, grp, q.picks ?? null, q.wide ? 1 : 0);   // a query sent again adds no item
    }
  } finally { db.close(); }
}

type Group = { kind: string; item: string; group: string | null; picks: number; arts: { pmid: string; line: string }[] };
export type Ask = (prompt: string, schema: object, name: string) => Promise<unknown>;

// Picks the top of every item. Returns how many items, how many got a pick, the calls and seconds.
export async function pickItems(lib: string, evid: string, env: NodeJS.ProcessEnv = process.env, ask?: Ask): Promise<{ ok: true; items: number; picked: number; papers: number; assigned: number; calls: number; fallbacks?: number; skipped?: number; problem?: string; seconds: number } | { ok: false; error: string }> {
  const t0 = Date.now();
  const rc = ask ? null : rankConfig(env);
  if (rc && !rc.ok) return { ok: false, error: `ranking model: ${rc.problem}` };
  const call: Ask = ask ?? ((prompt, schema, name) => askJson((rc as Extract<typeof rc, { ok: true }>).config, (rc as Extract<typeof rc, { ok: true }>).model, prompt, schema, name));
  const pr = activePrompt("ranking", env);
  if (pr.problem) return { ok: false, error: `prompts: ${pr.problem}` };
  const template = promptStep(pr.text, "items") ?? ITEMS_PROMPT;
  const N = itemCandidates(env), K = itemPicks(env);
  const picksOf = (g: { picks: number }) => g.picks;
  const db = openDb(evidDir(lib, evid.replace(/^evid:/, "")));
  try {
    const topic = metaOf(db, "topic") ?? "";
    const LINE = "a.pmid, a.title, a.year, a.design, a.n, a.relevance, a.aspect, a.citations, a.population, a.types";
    const line = (x: unknown[]) => ({ pmid: String(x[0]), line: `${x[1] ?? "(no title)"} (${x[2] ?? "-"}; ${x[3] || "-"}; n=${x[4] ?? "-"}; ${x[8] && x[8] !== "none" ? `${x[8]}; ` : ""}${x[5]}; ${x[6]}${x[7] != null ? `; cited ${x[7]} times` : ""})` });
    const all = itemRows(db);
    let failed = "", calls = 0, lastError = "", skipped = 0, fallbacks = 0;
    // Assign: which of the map's best articles belong to which item, whatever query found them.
    const targets = all.filter((x) => !x.wide).map((x) => [x.kind, x.item, x.grp] as [string, string, string | null]);
    const best = targets.length ? query(db, "SELECT pmid, title, year, design, n, finding FROM evidence_map WHERE score IS NOT NULL ORDER BY score DESC, pmid", [], 0, assignArticles(env)).rows : [];
    const pairs: [string, string, string][] = [];
    if (best.length) {
      const assign = promptStep(pr.text, "assign") ?? ASSIGN_PROMPT;
      const list = targets.map(([kind, item, group], i) => `${i + 1}. ${kind}${group && group !== "overall" ? ` (${group})` : ""}: ${item}`).join("\n");
      const parts: unknown[][][] = [];
      for (let i = 0; i < best.length; i += ASSIGN_PER_CALL) parts.push(best.slice(i, i + ASSIGN_PER_CALL));
      let at = 0;
      await Promise.all(Array.from({ length: Math.min(CALLS_AT_ONCE, parts.length) }, async () => {
        while (at < parts.length && !failed) {
          const part = parts[at++]; calls++;
          const text = part.map((x, j) => `${j + 1}. ${x[1] ?? "(no title)"} (${x[2] ?? "-"}; ${x[3] || "-"}; n=${x[4] ?? "-"})${x[5] ? ` — ${x[5]}` : ""}`).join("\n");
          // one refused or failed call does not stop the step: once more, then this part of the articles stays unassigned
          for (let attempt = 0; attempt < 2; attempt++) try {
            const a = await call(assign.split("{{topic}}").join(topic).split("{{items}}").join(list).split("{{articles}}").join(text), ASSIGN_SCHEMA, "item_articles") as { articles?: { article: number; items: number[] }[] };
            for (const x of a.articles ?? []) { const art = part[x.article - 1]; if (!art || !Array.isArray(x.items)) continue; for (const n of new Set(x.items)) { const t = targets[n - 1]; if (t) pairs.push([t[0], t[1], String(art[0])]); } }
            break;
          } catch (e) { lastError = e instanceof Error ? e.message : String(e); skipped += attempt; }
        }
      }));
    }
    db.exec("BEGIN");
    db.exec("DELETE FROM item_articles");
    const put = db.prepare("INSERT OR IGNORE INTO item_articles (kind, item, pmid) VALUES (?, ?, ?)");
    for (const x of pairs) put.run(...x);
    db.exec("COMMIT");
    // An item's candidates: the best of its own query's results, then the best of those assigned to it.
    const groups: Group[] = [];
    for (const { kind, item, grp: group, picks, wide } of all) {
      const own = query(db, `SELECT ${LINE}, MAX(a.score) AS s
        FROM query_items i JOIN queries q ON q.query = i.query JOIN query_hits h ON h.query_id = q.id JOIN evidence_map a ON a.pmid = h.pmid
        WHERE i.kind = ? AND i.item = ? AND a.score IS NOT NULL GROUP BY a.pmid ORDER BY s DESC`, [kind, item], 0, wide ? N * 3 : N).rows.filter((x) => !(wide && SR_SECTION.test(kind)) || SR.test(`${x[9] ?? ""} ${x[1] ?? ""}`)).map(line);
      const has = new Set(own.map((a) => a.pmid));
      const more = query(db, `SELECT ${LINE} FROM item_articles x JOIN evidence_map a ON a.pmid = x.pmid WHERE x.kind = ? AND x.item = ? AND a.score IS NOT NULL ORDER BY a.score DESC`, [kind, item], 0, 1000).rows.map(line).filter((a) => !has.has(a.pmid)).slice(0, N);
      if (own.length + more.length) groups.push({ kind, item, group, picks: picks ?? K, arts: [...own, ...more] });
    }
    const picks: string[][] = groups.map(() => []);
    const batches: number[][] = [];
    for (let i = 0; i < groups.length; i += PER_CALL) batches.push(groups.slice(i, i + PER_CALL).map((_, k) => i + k));
    let next = 0;
    const heading = (gi: number, k: number) => `Group ${k + 1} — ${groups[gi].kind}${groups[gi].group && groups[gi].group !== "overall" ? ` (${groups[gi].group})` : ""}: ${groups[gi].item}${picksOf(groups[gi]) !== K ? ` (up to ${picksOf(groups[gi])})` : ""}\n${groups[gi].arts.map((a, j) => `${j + 1}. ${a.line}`).join("\n")}`;
    const ask = async (b: number[]): Promise<void> => {
      calls++;
      const a = await call(template.split("{{topic}}").join(topic).split("{{picks}}").join(String(K)).split("{{groups}}").join(b.map(heading).join("\n\n")), SCHEMA, "item_picks") as { groups?: { group: number; picks: number[] }[] };
      for (const g of a.groups ?? []) { const gi = b[g.group - 1]; if (gi === undefined || !Array.isArray(g.picks)) continue; picks[gi] = [...new Set(g.picks)].filter((j) => Number.isInteger(j) && j >= 1 && j <= groups[gi].arts.length).slice(0, picksOf(groups[gi])).map((j) => groups[gi].arts[j - 1].pmid); }
    };
    // One refused or failed call does not stop the step (a map ended "done" with no article on any aspect, 2026-11-24):
    // the batch once more, then each of its aspects alone; an aspect whose own call fails too gets its best-scored
    // candidates in place of the model's picks.
    await Promise.all(Array.from({ length: Math.min(CALLS_AT_ONCE, batches.length) }, async () => {
      while (next < batches.length) {
        const b = batches[next++];
        try { await ask(b); continue; } catch (e) { lastError = e instanceof Error ? e.message : String(e); }
        try { await ask(b); continue; } catch (e) { lastError = e instanceof Error ? e.message : String(e); }
        for (const gi of b) try { await ask([gi]); } catch (e) { lastError = e instanceof Error ? e.message : String(e); fallbacks++; picks[gi] = groups[gi].arts.slice(0, picksOf(groups[gi])).map((a) => a.pmid); }
      }
    }));
    // no call answered at all: the model cannot be reached or refuses everything — the picking failed, nothing is stored
    if (groups.length && fallbacks === groups.length) failed = lastError;
    if (failed) return { ok: false, error: failed };
    db.exec("BEGIN");
    db.exec("DELETE FROM item_picks");
    const ins = db.prepare("INSERT OR IGNORE INTO item_picks (kind, item, pmid, pick) VALUES (?, ?, ?, ?)");
    groups.forEach((g, i) => picks[i].forEach((p, k) => ins.run(g.kind, g.item, p, k + 1)));
    db.exec("DELETE FROM item_candidates");
    const saw = db.prepare("INSERT OR IGNORE INTO item_candidates (kind, item, pmid, pos) VALUES (?, ?, ?, ?)");
    groups.forEach((g) => g.arts.forEach((a, k) => saw.run(g.kind, g.item, a.pmid, k + 1)));
    db.exec("COMMIT");
    return { ok: true, items: groups.length, picked: picks.filter((p) => p.length).length, papers: new Set(picks.flat()).size, assigned: pairs.length, calls, ...(fallbacks || skipped ? { fallbacks, skipped, problem: lastError } : {}), seconds: Math.round((Date.now() - t0) / 1000) };
  } finally { db.close(); }
}

// The map by item: each item with its picked articles (in the order picked), table by table —
// reviews, benefits, risks, interactions, protocol — and inside a table in the order the discovery wrote them. kind: one kind only. null: the map has no items (none built yet).
// Short rows: a map has a few hundred of them (Vitamin C: 388 for 134 items); the abstract is in the library.
// What a caller reads: the map by section, a section's aspects, an aspect's articles as PMIDs — the picked ones
// first, in the order picked, then the others assigned to it, by score, then what else the picking saw for it. Any one of them backs the aspect; what an
// article is (design, participants) is in the library. (The database says kind for section and item for aspect.)
export type Aspect = { id: number; section: string; aspect: string; pmids: string[] };
// What a section without an aspect says of itself.
export const NO_ASPECT = "the map found no aspect for this section";
// An aspect the discovery listed but no article was picked for is not part of what a caller reads: the map points to
// PubMed research, and such an aspect points to nothing — nor is it shown to be real (decided 2026-11-24).
export const aspectArticles = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_ASPECT_ARTICLES", 10, env, (n) => n >= 1 && n <= 50 && Number.isInteger(n));

// sections: the map's sections in their order, with how many aspects each has — what sections a map has is what
// its aspects say. aspects: those of one section (its name, case ignored), or the one with this id; neither: none.
export function getAspects(lib: string, evid: string, opts: { section?: string; id?: number; all?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): { sections: { section: string; aspects: number }[]; aspects: Aspect[] } | null {
  const db = openDb(evidDir(lib, evid.replace(/^evid:/, "")), true);
  if (!db) return null;
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'item_picks'").get()) return null;
    const listed = itemRows(db);
    if (!listed.length) return null;
    const all = shownAspects(db);
    let declared: string[] = [];
    try { declared = JSON.parse(metaOf(db, "sections") ?? "[]") as string[]; } catch { /* a map built before the sections were stored */ }
    const sections: { section: string; aspects: number }[] = (declared.length ? declared : [...new Set(listed.map((x) => x.kind))]).map((section) => ({ section, aspects: 0 }));
    for (const x of all) { const s = sections.find((y) => y.section === x.kind); if (s) s.aspects++; else sections.push({ section: x.kind, aspects: 1 }); }
    const max = aspectArticles(env), want = opts.section?.trim().toLowerCase();
    const assigned = !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'item_articles'").get();
    const candidates = !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'item_candidates'").get();
    const aspects: Aspect[] = [];
    for (const { id, kind, item } of all) {
      if (opts.id !== undefined ? id !== opts.id : !opts.all && kind.toLowerCase() !== want) continue;
      const picked = (db.prepare("SELECT pmid FROM item_picks WHERE kind = ? AND item = ? ORDER BY pick").all(kind, item) as { pmid: string }[]).map((x) => x.pmid);
      const more = assigned && picked.length ? (db.prepare("SELECT x.pmid FROM item_articles x JOIN evidence_map a ON a.pmid = x.pmid WHERE x.kind = ? AND x.item = ? AND a.score IS NOT NULL ORDER BY a.score DESC").all(kind, item) as { pmid: string }[]).map((x) => x.pmid).filter((p) => !picked.includes(p)) : [];
      const seen = candidates && picked.length ? (db.prepare("SELECT pmid FROM item_candidates WHERE kind = ? AND item = ? ORDER BY pos").all(kind, item) as { pmid: string }[]).map((x) => x.pmid).filter((p) => !picked.includes(p) && !more.includes(p)) : [];
      const pmids = [...picked, ...more, ...seen].slice(0, Math.max(max, picked.length));
      aspects.push({ id, section: kind, aspect: item, pmids });
    }
    return { sections, aspects };
  } finally { db.close(); }
}

// The aspects a caller may be told of: those with at least one picked article. The one gate for every answer —
// the map, the info, a gap report: an aspect the discovery listed and nothing was picked for stays in the database
// (it shows us where a list or the picking is off, and a later picking may fill it) and is named nowhere.
export function shownAspects(db: Db): ItemRow[] {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'item_picks'").get()) return [];
  // Two columns, joined here: Node 22 cuts a text the database returns at a NUL character, so a key joined with
  // char(0) in SQL came back as the kind alone and every map read as empty there (found by CI on Node 22, 2026-11-26).
  const withArticle = new Set((db.prepare("SELECT DISTINCT kind, item FROM item_picks").all() as { kind: string; item: string }[]).map((x) => `${x.kind}\u0000${x.item}`));
  return itemRows(db).filter((x) => withArticle.has(`${x.kind}\u0000${x.item}`));
}

// A value kept with the map (null: removed), and reading one.
export function setMeta(lib: string, evid: string, key: string, value: string | null): void {
  const db = openDb(evidDir(lib, evid.replace(/^evid:/, "")));
  try { if (value === null) db.prepare("DELETE FROM meta WHERE key = ?").run(key); else db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value); } finally { db.close(); }
}
export function metaOfMap(lib: string, evid: string, key: string): string | undefined {
  const db = openDb(evidDir(lib, evid.replace(/^evid:/, "")), true);
  if (!db) return undefined;
  try { return metaOf(db, key); } catch { return undefined; } finally { db.close(); }
}
// The lists the discovery could not write (the model refused or the call failed, twice), with the sections they
// fill: such a section was not built — "no aspect found" would be wrong. A build call on the EVID writes them again.
export function failedLists(lib: string, evid: string): { list: string; sections: string[]; error: string }[] {
  try { const v = JSON.parse(metaOfMap(lib, evid, "failed_lists") ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
export const notBuilt = (lib: string, evid: string): { section: string; error: string }[] => failedLists(lib, evid).flatMap((f) => f.sections.map((section) => ({ section, error: f.error })));
export const NOT_BUILT = "the aspects of this section could not be written; fh_evmap_create_map with this evid writes them";

// A map's size, for fh_evmap_get_info: its queries, its articles (off-topic ones not counted) and the articles picked for its items.
export function mapCounts(lib: string, evid: string): { queries: number; articles: number; picked_articles: number } | null {
  const db = openDb(evidDir(lib, evid.replace(/^evid:/, "")), true);
  if (!db) return null;
  try {
    const n = (sql: string) => { try { return (db.prepare(sql).get() as { n: number }).n; } catch { return 0; } };
    return { queries: n("SELECT COUNT(*) AS n FROM queries"), articles: n("SELECT COUNT(*) AS n FROM evidence_map"), picked_articles: n("SELECT COUNT(DISTINCT pmid) AS n FROM item_picks") };
  } finally { db.close(); }
}
