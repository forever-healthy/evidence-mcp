import { num } from "./env.js";
import { fetchText } from "./http.js";
import { activePrompt, builtinPrompt, promptSections } from "./prompts.js";
import { esearchUrl, normalizeQuery, parseEsearch } from "./pubmedsearch.js";
import { askJson, rankConfig } from "./rank.js";
import { evidDir } from "./evid.js";
import { openDb, query } from "./evmapdb.js";
import { doResearch, live, maxResultsPerQuery } from "./evidencemap.js";
import { log } from "./log.js";
import { failedLists, itemRows, metaOfMap, pickItems, setItems, setMeta } from "./items.js";
import { mapTables, sectionOf, type List } from "./tables.js";

// Discovery: the server writes the map's queries itself (decided 2026-11-22; before, the calling
// agent wrote them). Two stages, as an audit works — it finds a paper because it asks one narrow
// question at a time:
//   1. survey  — a few queries for the reviews of the intervention; they are searched and screened;
//   2. items   — from the titles the survey kept, the model writes one list per table (evmap/discovery.md, Tables: by default the benefits,
//                the risks, the interactions and the protocol of an evidence review), each item with its own
//                narrow query; those are searched and screened too.
// The survey is read whole: before its queries run, each one's hits are counted (one request), and a query with
// more hits than are read (FH_EVMAP_MAX_RESULTS_PER_QUERY) goes back to the model to be split or narrowed
// — FH_EVMAP_DISCOVERY_ITERATIONS in all, the first writing counted (3: it goes back twice). The prompt: evmap/discovery.md, one section
// per step. The steps and their bounds are code; what each step asks is the prompt.
// stuff/evmap/discovery/discovery.md has what was measured.

export type DQuery = { label: string; query: string; kind?: string; group?: string; hits?: number | null };
export type DiscoveryDeps = {
  ask: (prompt: string, schema: object, name: string) => Promise<unknown>;
  hits: (query: string) => Promise<number | null>;   // PubMed's count for a query; null: the count failed
  log: (message: string) => void;
  configured?: true;   // tests: the deps stand in for a configured model
  pick?: (prompt: string, schema: object, name: string) => Promise<unknown>;   // tests: the ranking model's picks per item
};
export const discoveryIterations = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_DISCOVERY_ITERATIONS", 3, env, (n) => n >= 1 && n <= 6 && Number.isInteger(n));   // the first writing counts: 1 — nothing goes back
// How many items a list may have is set per table (evmap/discovery.md, Tables). Of their own each: in one common list the benefits crowded the
// risks out (five reviews 2026-11-22: about 85 benefits and 10 risks of 120 items; half the risks the audits added were missing).
// An item's query reads PubMed's first few results, not the general maximum: a narrow question's answer is on
// its first page, as an auditor reads it. Vitamin C 2026-11-22: 26 of the 27 benefit reviews the audits added
// are in the first 50 of an item's query; reading 500 of each meant 21,826 abstracts screened for one map.
export const discoveryItemResults = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_DISCOVERY_ITEM_RESULTS", 50, env, (n) => n >= 5 && n <= 500 && Number.isInteger(n));
// The survey reads the first results of each of its queries too: it is there to show what has been studied —
// the titles — not to collect every article (run of 2026-11-22: read whole and split, the survey alone had
// 5,264 abstracts screened, two thirds of the map's).
export const discoverySurveyResults = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_DISCOVERY_SURVEY_RESULTS", 200, env, (n) => n >= 20 && n <= 1000 && Number.isInteger(n));
export const discoveryTitles = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_DISCOVERY_TITLES", 800, env, (n) => n >= 50 && n <= 3000 && Number.isInteger(n));

const Q = { type: "object", properties: { label: { type: "string" }, query: { type: "string" } }, required: ["label", "query"], additionalProperties: false } as const;
// The answers' forms follow the tables in force (src/tables.ts): the survey's kinds of query, a list's groups.
const surveySchema = (kinds: string[]) => ({ type: "object", properties: { queries: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: [...kinds, "other"] }, label: { type: "string" }, query: { type: "string" } }, required: ["kind", "label", "query"], additionalProperties: false } } }, required: ["queries"], additionalProperties: false });
const itemsSchema = (groups: string[]) => ({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: { ...(groups.length ? { group: { type: "string", enum: groups } } : {}), label: { type: "string" }, query: { type: "string" } }, required: [...(groups.length ? ["group"] : []), "label", "query"], additionalProperties: false } } }, required: ["items"], additionalProperties: false });
const ITERATION = { type: "object", properties: { replacements: { type: "array", items: { type: "object", properties: { number: { type: "integer" }, queries: { type: "array", items: Q } }, required: ["number", "queries"], additionalProperties: false } } }, required: ["replacements"], additionalProperties: false } as const;

const PER_ITERATION_CALL = 12;
const fill = (text: string, slots: Record<string, string>): string => Object.entries(slots).reduce((t, [k, v]) => t.split(`{{${k}}}`).join(v), text);
const clean = (qs: DQuery[]): DQuery[] => { const seen = new Set<string>(); return qs.map((q) => ({ ...q, query: q.query.replace(/\s+/g, " ").trim() })).filter((q) => q.query && !seen.has(q.query) && seen.add(q.query)); };

// The sections of the discovery prompt in force, {{hints}} and {{item_query}} put in. lists: one step per table
// that has a list (a table without one — the major systematic reviews — is the survey's own item: no list to write).
export function discoverySteps(env: NodeJS.ProcessEnv = process.env): { survey: string; iteration: string; empty: string; lists: Record<string, string> } {
  const s = promptSections(activePrompt("discovery", env).text);
  const put = (t: string | undefined) => fill(t ?? "", { item_query: s["item query"] ?? "", hints: s.hints ?? "" });
  // Empty: a prompt folder written before the step existed has no such section — the built-in one serves
  return { survey: put(s.survey), iteration: put(s.iteration), empty: put(s.empty ?? promptSections(builtinPrompt("discovery")).empty), lists: Object.fromEntries(mapTables(env).lists.map((l) => [l.name, put(s[l.name])])) };
}

// A survey query that finds nothing is written once more (Nicotinamide Riboside 2026-11-24: the systematic-review
// query had only title names and an unbracketed AND, 0 hits, and the map lacked the class's reviews). One call for
// all of them; a query that still finds nothing, or a failed call, stays as it is.
export async function refill(topic: string, queries: DQuery[], emptyPrompt: string, deps: DiscoveryDeps): Promise<{ queries: DQuery[]; rewritten: number }> {
  if (!emptyPrompt.trim()) return { queries, rewritten: 0 };
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(10, queries.length) }, async () => { while (k < queries.length) { const q = queries[k++]; if (q.hits === undefined) q.hits = await deps.hits(q.query).catch(() => null); } }));
  const none = queries.filter((q) => q.hits === 0);
  if (!none.length) return { queries, rewritten: 0 };
  deps.log(`survey: ${none.length} of ${queries.length} queries found nothing, writing them again`);
  const by = new Map<DQuery, DQuery>();
  try {
    const a = await deps.ask(fill(emptyPrompt, { topic, queries: none.map((q, i) => `${i + 1}. ${q.query}`).join("\n") }), ITERATION, "empty") as { replacements?: { number: number; queries: DQuery[] }[] };
    for (const r of a.replacements ?? []) {
      const old = none[r.number - 1], query = r.queries?.[0]?.query?.replace(/\s+/g, " ").trim();
      if (!old || !query || query === old.query) continue;
      const hits = await deps.hits(query).catch(() => null);
      if (hits) by.set(old, { label: old.label, kind: old.kind, query, hits });   // the same question: its label and kind stay
    }
  } catch (e) { deps.log(`survey: the call failed, the queries stay as they are · ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`); }
  return { queries: clean(queries.map((q) => by.get(q) ?? q)), rewritten: by.size };
}

// Counts each query's hits; those over the limit go back to the model. iterations: how many in all, the first writing counted.
export async function fit(topic: string, queries: DQuery[], limit: number, iterations: number, iterationPrompt: string, deps: DiscoveryDeps): Promise<{ queries: DQuery[]; iterated: number; over: number }> {
  let qs = clean(queries), iterated = 0;
  const count = async (list: DQuery[]) => { let k = 0; await Promise.all(Array.from({ length: Math.min(10, list.length) }, async () => { while (k < list.length) { const q = list[k++]; if (q.hits === undefined) q.hits = await deps.hits(q.query).catch(() => null); } })); };
  for (let pass = 0; ; pass++) {
    await count(qs);
    const over = qs.filter((q) => (q.hits ?? 0) > limit);
    if (!over.length || pass + 1 >= iterations) return { queries: qs, iterated, over: over.length };
    deps.log(`iteration ${pass + 2}: ${over.length} of ${qs.length} queries over ${limit} hits`);
    // A few queries per call, so an answer stays short (45 at once ran past the answer's length,
    // 2026-11-22); a call that fails leaves its queries as they are — the map is built all the same.
    const by = new Map<DQuery, DQuery[]>();
    const chunks: DQuery[][] = [];
    for (let i = 0; i < over.length; i += PER_ITERATION_CALL) chunks.push(over.slice(i, i + PER_ITERATION_CALL));
    let nextChunk = 0;
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, async () => {
      while (nextChunk < chunks.length) {
        const c = chunks[nextChunk++];
        try {
          const a = await deps.ask(fill(iterationPrompt, { topic, limit: String(limit), queries: c.map((q, i) => `${i + 1}. ${q.hits} hits: ${q.query}`).join("\n") }), ITERATION, "iteration") as { replacements?: { number: number; queries: DQuery[] }[] };
          for (const r of a.replacements ?? []) if (c[r.number - 1] && Array.isArray(r.queries)) by.set(c[r.number - 1], r.queries);
        } catch (e) { deps.log(`iteration ${pass + 2}: a call failed, ${c.length} queries stay as they are · ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`); }
      }
    }));
    const next: DQuery[] = [];
    for (const q of qs) {
      const rep = by.get(q);
      if (!rep?.length) { next.push(q); continue; }
      iterated++;
      // the pieces of a split query stay the same item: its name and kind, not the piece's own label
      // ("trials", "reviews" — as items of their own they scatter the item's articles, run of 2026-11-22)
      for (const r of rep) next.push(r.query.replace(/\s+/g, " ").trim() === q.query ? q : { label: q.label, query: r.query, kind: q.kind });
    }
    qs = clean(next);
  }
}

export type DiscoveryReport = { survey: DQuery[]; items: DQuery[]; iterated: number; over: number; titles: number; seconds: number; picks?: { items: number; picked: number; papers: number; assigned: number; calls: number; seconds: number } | { error: string } };

// The whole map for a topic's EVID: survey, items, each stage fitted, searched and screened; the
// ranking runs once, at the end.
export async function discoverMap(lib: string, evid: string, topic: string, env: NodeJS.ProcessEnv = process.env, deps: DiscoveryDeps = liveDeps(env, (m) => log("evmap", evid, `discovery ${m}`))): Promise<({ ok: true; evid: string; included: number; discovery: DiscoveryReport }) | { ok: false; error: string; failed?: true }> {
  const t0 = Date.now();
  const dc = rankConfig(env, "DISCOVERY");
  if (!dc.ok && deps.configured !== true) return { ok: false, failed: true, error: `discovery model: ${dc.problem}. Nothing ran. It is set in the server's .env by whoever runs the server.` };
  // the ranking's settings and prompt too: the picks per aspect are the last step, and a build that fails there has done all its work for nothing
  const rk = rankConfig(env);
  if (!rk.ok && deps.configured !== true && !deps.pick) return { ok: false, failed: true, error: `ranking model: ${rk.problem}. Nothing ran. It is set in the server's .env by whoever runs the server.` };
  const pk = activePrompt("ranking", env);
  if (pk.problem) return { ok: false, failed: true, error: `prompts: ${pk.problem}. Nothing ran. It is set in the server's .env by whoever runs the server.` };
  const pd = activePrompt("discovery", env);
  if (pd.problem) return { ok: false, failed: true, error: `prompts: ${pd.problem}. Nothing ran. It is set in the server's .env by whoever runs the server.` };
  const mt = mapTables(env);
  if (mt.problem) return { ok: false, failed: true, error: `prompts: ${mt.problem}. Nothing ran. It is set in the server's .env by whoever runs the server.` };
  const whole = new Set(mt.survey.filter((x) => x.whole).map((x) => x.name));
  const steps = discoverySteps(env), limit = maxResultsPerQuery(env), iterations = discoveryIterations(env);
  const same = (a: string | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
  const itemResults = discoveryItemResults(env);
  // The lists, each from the survey's titles, each with its own allowance.
  // A list reads first every result of the survey's queries of its own kind, whatever the screening made of it (one
  // drug's single study is what makes the drug an item, and the screening has called such studies off-topic, a
  // letter, or "efficacy": Vitamin C 2026-11-22), then the articles the screening gave its aspect, then by score.
  // A list whose call is refused or fails is asked once more; failing again it stays empty, and the map is built
  // from the others (a build died here with nothing said: the model refused one list, 2026-11-24).
  const writeLists = async (db: NonNullable<ReturnType<typeof openDb>>, lists: List[], surveyQs: DQuery[]): Promise<{ answers: { list: string; items: DQuery[]; n: number }[]; failures: string[] }> => {
    // "found harm": the screening read the abstract and the intervention made its outcome worse — a title rarely says so
    // (the NOPARK trial of nicotinamide riboside in Parkinson's disease, 2026-11-24), and a list is written from titles.
    const line = (x: unknown[]) => `- ${x[0]} (${x[1] ?? "-"}; ${x[2] || "-"}; ${x[3] || "-"}${x[4] === "harm" ? "; found harm" : ""})`;
    const titlesFor = (t: List): { text: string; n: number } => {
      const own = surveyQs.filter((q) => t.titlesFrom.includes(q.kind ?? "")).map((q) => q.query);
      const first = own.length ? query(db, `SELECT a.title, a.year, a.design, a.aspect, a.finding, MIN(h.rank) AS r FROM queries q JOIN query_hits h ON h.query_id = q.id JOIN articles a ON a.pmid = h.pmid WHERE a.title IS NOT NULL AND q.query IN (${own.map(() => "?").join(", ")}) GROUP BY a.pmid ORDER BY r`, own, 0, discoveryTitles(env)).rows : [];
      const seen = new Set(first.map((x) => String(x[0])));
      const rest = query(db, "SELECT title, year, design, aspect, finding FROM evidence_map WHERE title IS NOT NULL ORDER BY (aspect = ? AND population = 'humans') DESC, score DESC", [t.label ?? ""], 0, discoveryTitles(env)).rows.filter((x) => !seen.has(String(x[0]))).slice(0, Math.max(0, discoveryTitles(env) - first.length));
      return { text: (first.length ? `From the survey's ${t.titlesFrom.join(" and ")} search${t.titlesFrom.length > 1 ? "es" : ""}:\n${first.map(line).join("\n")}\n\nThe other titles:\n` : "") + rest.map(line).join("\n"), n: first.length + rest.length };
    };
    const failures: string[] = [];
    const answers = await Promise.all(lists.map(async (l) => {
      if (!l.max || !steps.lists[l.name]) return { list: l.name, items: [] as DQuery[], n: 0 };
      const groups = [...new Set(mt.sections.filter((x) => x.list === l.name).flatMap((x) => x.groups))];
      const t = titlesFor(l);
      for (let attempt = 0; ; attempt++) {
        try {
          const a = await deps.ask(fill(steps.lists[l.name], { topic, titles: t.text, max: String(l.max) }), itemsSchema(groups), l.name) as { items?: DQuery[] };
          return { list: l.name, items: (a.items ?? []).slice(0, l.max), n: t.n };
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          if (attempt === 0) { deps.log(`list ${l.name}: asked once more after: ${why.slice(0, 200)}`); continue; }
          deps.log(`list ${l.name} failed: ${why.slice(0, 300)}`);
          failures.push(`${l.name}: ${why}`);
          return { list: l.name, items: [] as DQuery[], n: t.n };
        }
      }
    }));
    return { answers, failures };
  };
  // A list that could not be written, kept with the map: its sections are "not built", not "nothing found", and a
  // build call on the EVID writes it again.
  const keepFailures = (failures: string[]) => setMeta(lib, evid, "failed_lists", failures.length ? JSON.stringify(failures.map((f) => { const list = f.split(":")[0]; return { list, sections: mt.sections.filter((x) => x.list === list).map((x) => x.name), error: f.slice(list.length + 2, list.length + 202) }; })) : null);
  const listAspects = (qs: DQuery[]) => mt.sections.flatMap((sec) => qs.filter((q) => sectionOf(mt, q.kind ?? "", q.group) === sec).map((q) => ({ query: q.query, kind: sec.name, item: q.label, group: q.group, picks: sec.picks })));
  // A map that has its aspects already, called again — a build whose picking failed, or one with lists that could
  // not be written: only that is left to do.
  const db0 = openDb(evidDir(lib, evid.replace(/^evid:/, "")), true);
  if (db0) {
    let have = 0, included = 0, added = 0;
    try { have = itemRows(db0).length; included = have ? Number(query(db0, "SELECT COUNT(*) FROM evidence_map", [], 0, 1).rows[0]?.[0] ?? 0) : 0; } catch { /* no map yet */ } finally { db0.close(); }
    if (have) {
      // its lists that could not be written are written now, searched and screened; then everything is picked again
      const again = failedLists(lib, evid).map((f) => f.list);
      let surveyQs: DQuery[] = [];
      try { surveyQs = JSON.parse(metaOfMap(lib, evid, "survey") ?? "[]") as DQuery[]; } catch { /* a map built before the survey was kept */ }
      if (again.length && surveyQs.length) {
        deps.log(`lists: writing again ${again.join(", ")}`);
        const db = openDb(evidDir(lib, evid.replace(/^evid:/, "")), true)!;
        const w = await writeLists(db, mt.lists.filter((l) => again.includes(l.name)), surveyQs).finally(() => db.close());
        const known = new Set(surveyQs.map((q) => q.query));
        const qs = clean(w.answers.flatMap((a) => a.items.map((q) => ({ ...q, kind: a.list })))).filter((q) => !known.has(q.query));
        deps.log(`aspects: ${w.answers.map((a) => `${a.items.length} ${a.list}`).join(", ")}${w.failures.length ? ` (failed: ${w.failures.map((f) => f.split(":")[0]).join(", ")})` : ""} — ${qs.length} queries`);
        if (qs.length) {
          const r = await doResearch(lib, evid, qs.map((q) => q.query), undefined, env, new Date(), live(lib), Object.fromEntries(qs.map((q) => [q.query, itemResults])));
          if (!r.ok) return { ok: false, error: `items: ${r.error}`, ...(r.failed ? { failed: true as const } : {}) };
          included = r.included;
          setItems(lib, evid, listAspects(qs)); added = listAspects(qs).length;
        }
        keepFailures(w.failures);
      }
      deps.log(`picking again: ${have + added} aspects`);
      const p = await pickItems(lib, evid, env, deps.pick);
      if (!p.ok) return { ok: false, error: `picking per aspect: ${p.error}` };
      deps.log(`picked ${p.papers} articles for ${p.picked} of ${p.items} aspects (${p.assigned} assignments from the whole map), ${p.calls} calls, ${p.seconds} s`);
      return { ok: true, evid, included, discovery: { survey: [], items: [], iterated: 0, over: 0, titles: 0, picks: { items: p.items, picked: p.picked, papers: p.papers, assigned: p.assigned, calls: p.calls, seconds: p.seconds }, seconds: Math.round((Date.now() - t0) / 1000) } };
    }
  }
  // 1. survey
  deps.log("survey: writing the queries");
  let s0: { queries?: DQuery[] };
  try { s0 = await deps.ask(fill(steps.survey, { topic }), surveySchema(mt.survey.map((x) => x.name)), "survey") as { queries?: DQuery[] }; }
  catch (e) { return { ok: false, failed: true, error: `survey: ${e instanceof Error ? e.message : String(e)}` }; }
  // FH_EVMAP_DISCOVERY_ITERATIONS above 1 and a survey read whole (FH_EVMAP_DISCOVERY_SURVEY_RESULTS at the general
  // maximum): its over-broad queries go back to the model; else each query's first results are read as they are.
  const surveyResults = Math.min(discoverySurveyResults(env), limit);
  const survey = surveyResults >= limit ? await fit(topic, s0.queries ?? [], limit, iterations, steps.iteration, deps) : { queries: clean(s0.queries ?? []), iterated: 0, over: 0 };
  survey.queries = (await refill(topic, survey.queries, steps.empty, deps)).queries;
  if (!survey.queries.length) return { ok: false, failed: true, error: "discovery: the model wrote no survey queries" };
  deps.log(`survey: ${survey.queries.length} queries`);
  const r1 = await doResearch(lib, evid, survey.queries.map((q) => q.query), undefined, env, new Date(), live(lib), Object.fromEntries(survey.queries.map((q) => [q.query, whole.has(q.kind ?? "") ? limit : surveyResults])));
  // (the interactions query is read whole: one drug's single study is what makes the drug an item, and it is rarely
  // on the first page — Vitamin C 2026-11-22: 4, 7 and 4 of 10 drugs became items when only the first 200 were read)
  if (!r1.ok) return { ok: false, error: `survey: ${r1.error}`, ...(r1.failed ? { failed: true as const } : {}) };
  // 2. the lists, one per table (writeLists above)
  const db = openDb(evidDir(lib, evid.replace(/^evid:/, "")), true)!;
  const have = new Set(survey.queries.map((q) => q.query));
  const listed: DQuery[] = []; let titleCount = 0; const counts: string[] = [];
  deps.log(`lists: writing ${mt.lists.map((l) => l.name).join(", ")}`);
  const { answers, failures: listFailures } = await writeLists(db, mt.lists, survey.queries);
  if (listFailures.length === mt.lists.length && listFailures.length) { db.close(); return { ok: false, failed: true, error: `lists: none could be written — ${listFailures[0]}` }; }
  // what a section without a list (the systematic reviews) can be picked from so far: the screened articles of its survey queries
  const candidates = mt.sections.filter((x) => !x.list).map((x) => {
    const names = mt.survey.filter((q) => same(q.section, x.name) && q.aspect).map((q) => q.name);
    const rq = survey.queries.filter((q) => names.includes(q.kind ?? "")).map((q) => q.query);
    return `${x.name.toLowerCase()}: ${rq.length ? Number(query(db, `SELECT COUNT(DISTINCT h.pmid) FROM queries q JOIN query_hits h ON h.query_id = q.id JOIN evidence_map a ON a.pmid = h.pmid WHERE a.score IS NOT NULL AND q.query IN (${rq.map(() => "?").join(", ")})`, rq, 0, 1).rows[0]?.[0] ?? 0) : 0} candidates`;
  });
  db.close();
  setMeta(lib, evid, "survey", JSON.stringify(survey.queries.map(({ label, query, kind }) => ({ label, query, kind }))));
  keepFailures(listFailures);
  for (const a of answers) { titleCount = Math.max(titleCount, a.n); counts.push(`${a.items.length} ${a.list}`); for (const q of a.items) listed.push({ ...q, kind: a.list }); }
  // the items' queries are not counted and not split: each reads its first results only, whatever its hits
  const items = { queries: clean(listed).filter((q) => !have.has(q.query)), iterated: 0, over: 0 };
  const rows = { length: titleCount };
  // the state at this point: the four lists as written; the systematic reviews table has no list — its rows are picked
  // at the end, from the candidates the survey found
  deps.log(`aspects: ${counts.join(", ")}${listFailures.length ? ` (failed: ${listFailures.map((f) => f.split(":")[0]).join(", ")})` : ""} — ${items.queries.length} queries${candidates.map((c) => `; ${c}`).join("")}`);
  const report: DiscoveryReport = { survey: survey.queries, items: items.queries, iterated: survey.iterated + items.iterated, over: survey.over + items.over, titles: rows.length, seconds: 0 };
  if (!items.queries.length) { const r = await doResearch(lib, evid, survey.queries.map((q) => q.query), undefined, env); return r.ok ? { ok: true, evid: r.evid, included: r.included, discovery: { ...report, seconds: Math.round((Date.now() - t0) / 1000) } } : { ok: false, error: r.error }; }
  const r2 = await doResearch(lib, evid, items.queries.map((q) => q.query), undefined, env, new Date(), live(lib), Object.fromEntries(items.queries.map((q) => [q.query, itemResults])));
  if (!r2.ok) return { ok: false, error: `items: ${r2.error}`, ...(r2.failed ? { failed: true as const } : {}) };
  // 3. the top of the map, picked per item (src/items.ts). The survey's queries belong to the five tables too: its
  // review queries are one item, the table of the major systematic reviews; its safety, interactions, pharmacokinetics
  // and guidelines queries are the overall item of their table; any other is no item (its articles stay in the map
  // and may be assigned to items).
  // The aspects in the order of the sections: a section's survey aspects first, then those of its list (by the group
  // the list's model named). A section without a list is "wide": its one aspect is the whole section — more
  // candidates, and no articles assigned to it from the rest of the map. An aspect of no section is left out.
  const surveyAspect = (q: DQuery) => mt.survey.find((x) => x.name === q.kind && x.aspect);
  setItems(lib, evid, mt.sections.flatMap((sec) => [
    ...survey.queries.filter((q) => same(surveyAspect(q)?.section, sec.name)).map((q) => ({ query: q.query, kind: sec.name, item: surveyAspect(q)!.aspect!, group: "overall", picks: sec.picks, wide: !sec.list })),
    ...listAspects(items.queries).filter((x) => x.kind === sec.name),
  ]), mt.sections.map((x) => x.name));
  const p = await pickItems(lib, evid, env, deps.pick);
  // The picking failed altogether: the map is not done — the build fails, and a call with the same EVID picks again.
  if (!p.ok) { deps.log(`picking per aspect failed: ${p.error}`); return { ok: false, error: `picking per aspect: ${p.error}` }; }
  deps.log(`picked ${p.papers} articles for ${p.picked} of ${p.items} aspects (${p.assigned} assignments from the whole map), ${p.calls} calls, ${p.seconds} s${p.fallbacks || p.skipped ? ` — ${p.fallbacks ?? 0} aspects by score, ${p.skipped ?? 0} assignment calls skipped: ${p.problem}` : ""}`);
  return { ok: true, evid: r2.evid, included: r2.included, discovery: { ...report, picks: { items: p.items, picked: p.picked, papers: p.papers, assigned: p.assigned, calls: p.calls, seconds: p.seconds }, seconds: Math.round((Date.now() - t0) / 1000) } };
}

export function liveDeps(env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => {}): DiscoveryDeps {
  const rc = rankConfig(env, "DISCOVERY");
  return {
    ask: async (prompt, schema, name) => { if (!rc.ok) throw new Error(`discovery model: ${rc.problem}`); return askJson(rc.config, rc.model, prompt, schema, name); },
    hits: async (q) => { const n = normalizeQuery({ query: q, max_results: 1 }, 1); if ("error" in n) return null; return parseEsearch(await fetchText(esearchUrl(n), { "User-Agent": "evidence-mcp", Accept: "application/json" })).total; },
    log,
  };
}
