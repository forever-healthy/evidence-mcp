import { activePrompt, promptSections } from "./prompts.js";

// What a map is made of is set by the discovery prompt, not by code (decided 2026-11-23/24). A map answers by
// section — the sections of the review that is to be written ("Expected Benefits", "Risk-Modifying Factors") —
// and a section holds aspects: the things the intervention has been studied for there ("Blood pressure", "Sex"),
// each with its articles. The prompt's section "## Tables" declares it in three Markdown tables:
//   Survey query | Read | Aspect | Section
//       a kind of query the Survey step writes; read "all" (its whole result) or "first" (its first results); the
//       aspect its results stand for ("Safety overall") and that aspect's section. No aspect: its articles are in
//       the map, under no aspect.
//   List | Max aspects | Titles from | Screening label
//       a prompt section that writes a list of aspects; its ceiling; the survey queries whose titles it reads first;
//       the screening's label its other titles are sorted by.
//   Section | List | Groups | Picks
//       a section of the review; the list its aspects come from and the groups of that list that belong to it
//       (separated by ";" — the list's model names each aspect's group); how many articles are picked per aspect
//       (none: FH_EVMAP_RANKING_ITEM_PICKS). A section without a list is its survey aspect alone (the systematic reviews).
// A map stores each aspect's section as plain text: what sections a map has is what its aspects say.

export type SurveyKind = { name: string; whole: boolean; aspect?: string; section?: string };
export type List = { name: string; max: number; titlesFrom: string[]; label?: string };
export type Section = { name: string; list?: string; groups: string[]; picks?: number };
export type MapTables = { survey: SurveyKind[]; lists: List[]; sections: Section[]; problem?: string };

const cell = (s: string | undefined): string => { const t = (s ?? "").trim(); return /^[—–-]*$/.test(t) ? "" : t; };
const low = (s: string | undefined): string => (s ?? "").trim().toLowerCase();
// The Markdown tables of a text, each as rows of cells keyed by the lower-cased header.
function mdTables(text: string): Record<string, string>[][] {
  const out: Record<string, string>[][] = []; let head: string[] | null = null, rows: Record<string, string>[] = [];
  const end = () => { if (head && rows.length) out.push(rows); head = null; rows = []; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) { end(); continue; }
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (!head) { head = cells.map((c) => c.toLowerCase()); continue; }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    rows.push(Object.fromEntries(head.map((h, i) => [h, cell(cells[i])])));
  }
  end();
  return out;
}

export function parseTables(prompt: string): MapTables {
  const s = promptSections(prompt);
  const all = mdTables(s.tables ?? "");
  const sv = all.find((t) => "survey query" in t[0]), ls = all.find((t) => "list" in t[0] && "max aspects" in t[0]), sc = all.find((t) => "section" in t[0] && "groups" in t[0]);
  if (!sv || !ls || !sc) return { survey: [], lists: [], sections: [], problem: "discovery.md needs a section \"## Tables\" with the survey's queries, the lists and the sections (sample: evmap/discovery.md)" };
  const int = (v: string | undefined) => { const n = Number(v); return v && Number.isInteger(n) && n > 0 ? n : undefined; };
  const split = (v: string | undefined, by: RegExp) => (v ?? "").split(by).map((g) => low(g)).filter(Boolean);
  const survey = sv.map((r) => ({ name: low(r["survey query"]), whole: low(r.read) === "all", ...(r.aspect ? { aspect: r.aspect } : {}), ...(r.section ? { section: r.section } : {}) })).filter((x) => x.name);
  const lists = ls.map((r) => ({ name: low(r.list), max: int(r["max aspects"]) ?? 0, titlesFrom: split(r["titles from"], /[;,]/), ...(r["screening label"] ? { label: low(r["screening label"]) } : {}) })).filter((x) => x.name);
  const sections = sc.map((r) => ({ name: r.section, ...(r.list ? { list: low(r.list) } : {}), groups: split(r.groups, /;/), ...(int(r.picks) ? { picks: int(r.picks) } : {}) })).filter((x) => x.name);
  const names = new Set(survey.map((x) => x.name)), secs = new Set(sections.map((x) => low(x.name))), listNames = new Set(lists.map((l) => l.name));
  const bad = [
    ...lists.filter((l) => !s[l.name]).map((l) => `list ${l.name}: no section "## ${l.name}" in the prompt`),
    ...lists.filter((l) => !l.max).map((l) => `list ${l.name}: no max aspects`),
    ...lists.flatMap((l) => l.titlesFrom.filter((n) => !names.has(n)).map((n) => `list ${l.name}: no survey query "${n}"`)),
    ...sections.filter((x) => x.list && !listNames.has(x.list)).map((x) => `section ${x.name}: no list "${x.list}"`),
    ...sections.filter((x) => !x.list && !survey.some((q) => low(q.section) === low(x.name) && q.aspect)).map((x) => `section ${x.name}: neither a list nor a survey aspect`),
    ...lists.filter((l) => { const g = sections.filter((x) => x.list === l.name); return g.length > 1 && g.some((x) => !x.groups.length); }).map((l) => `list ${l.name}: it serves several sections, so each needs its groups`),
    ...survey.filter((x) => x.aspect && !secs.has(low(x.section))).map((x) => `survey query ${x.name}: no section "${x.section ?? ""}"`),
    ...(sections.length === secs.size ? [] : ["a section is named twice"]),
  ];
  return { survey, lists, sections, ...(bad.length ? { problem: `discovery.md, ## Tables: ${bad.join("; ")}` } : {}) };
}

// The tables in force: those of the discovery prompt in force.
export function mapTables(env: NodeJS.ProcessEnv = process.env): MapTables {
  return parseTables(activePrompt("discovery", env).text);
}
// The section an aspect of a list belongs to, by the group its model named.
export function sectionOf(t: MapTables, list: string, group: string | undefined): Section | undefined {
  const mine = t.sections.filter((x) => x.list === list);
  return mine.find((x) => x.groups.includes(low(group))) ?? (mine.length === 1 ? mine[0] : undefined);
}
