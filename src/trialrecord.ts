import { words } from "./ctgov.js";

// fh_clinicaltrials_get_study_record and _results: two thin answers over the
// stored nct: entry — the raw ClinicalTrials.gov JSON (<entry>-fulltext.json)
// and the Markdown the converter wrote (<entry>-fulltext.md). The fleet's
// logs show what the models wanted from the old server's get_study_record
// (6,629 calls) and get_study_results (205): does this NCT resolve and do its
// title, conditions and interventions relate to the review (ER.md 28.13); what
// did it find (28.8). The record answer is the search row with the detail the
// review needs on top; the results answer is the "## Results" part of the
// stored Markdown, capped, with its outcome titles listed for fh_library_read.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const list = (a: J): J[] => (Array.isArray(a) ? a : []);
const para = (s: unknown, max = Infinity): string | null => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); if (!t) return null; return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t; };
const joined = (xs: (string | null)[]): string | null => { const ys = xs.filter((x): x is string => !!x); return ys.length ? ys.join("; ") : null; };
const dated = (d: J): string | null => (d?.date ? `${d.date}${d.type ? ` (${String(d.type).toLowerCase()})` : ""}` : null);

export type RecordSummary = {
  nct: string; title: string; official_title: string | null; acronym: string | null;
  status: string | null; why_stopped: string | null; phase: string | null; study_type: string | null; design: string | null;
  enrollment: string | null;
  start: string | null; primary_completion: string | null; completion: string | null; last_update: string | null; results_first_posted: string | null;
  sponsor: string | null; collaborators: string | null;
  conditions: string | null; interventions: string | null;
  primary_outcomes: string[]; secondary_outcomes: number;
  eligibility: string | null; locations: string | null;
  publications: string[];        // pmid:… of references typed result or derived — fh_library_add takes them
  has_results: boolean;
  summary: string | null;        // the brief summary, cut at 400 characters
};

export function recordSummary(json: string): RecordSummary | null {
  let d: J; try { d = JSON.parse(json); } catch { return null; }
  const ps = d?.protocolSection; if (!ps) return null;
  const idm = ps.identificationModule ?? {}, st = ps.statusModule ?? {}, sp = ps.sponsorCollaboratorsModule ?? {}, de = ps.descriptionModule ?? {};
  const dm = ps.designModule ?? {}, ai = ps.armsInterventionsModule ?? {}, om = ps.outcomesModule ?? {}, el = ps.eligibilityModule ?? {}, cl = ps.contactsLocationsModule ?? {}, rf = ps.referencesModule ?? {};
  const nct = String(idm.nctId ?? "").toUpperCase();
  const title = para(idm.briefTitle) ?? nct;
  const official = para(idm.officialTitle);
  const di = dm.designInfo ?? {}, mi = di.maskingInfo ?? {};
  const design = joined([di.allocation ? words(di.allocation) : null, di.interventionModel ? words(di.interventionModel) : null, mi.masking ? `masking ${words(mi.masking).toLowerCase()}` : null, di.primaryPurpose ? `purpose ${words(di.primaryPurpose).toLowerCase()}` : null]);
  const outcome = (o: J) => `${para(o.measure) ?? ""}${o.timeFrame ? ` (${para(o.timeFrame)})` : ""}`.trim();
  const countries = [...new Set(list(cl.locations).map((l: J) => l.country).filter(Boolean))] as string[];
  const refs = list(rf.references);
  const age = el.minimumAge || el.maximumAge ? `${el.minimumAge ?? "no minimum"} to ${el.maximumAge ?? "no maximum"}` : null;
  return {
    nct, title, official_title: official && official !== title ? official : null, acronym: para(idm.acronym),
    status: st.overallStatus ? words(st.overallStatus) : null, why_stopped: para(st.whyStopped),
    phase: list(dm.phases).length ? list(dm.phases).map(words).join(" / ") : null, study_type: dm.studyType ? words(dm.studyType) : null, design,
    enrollment: dm.enrollmentInfo?.count !== undefined ? `${dm.enrollmentInfo.count}${dm.enrollmentInfo.type ? ` (${String(dm.enrollmentInfo.type).toLowerCase()})` : ""}` : null,
    start: dated(st.startDateStruct), primary_completion: dated(st.primaryCompletionDateStruct), completion: dated(st.completionDateStruct),
    last_update: st.lastUpdatePostDateStruct?.date ?? null, results_first_posted: st.resultsFirstPostDateStruct?.date ?? null,
    sponsor: para(sp.leadSponsor?.name), collaborators: collaboratorsLine(list(sp.collaborators).map((c: J) => para(c.name)).filter(Boolean) as string[]),
    conditions: joined(list(ps.conditionsModule?.conditions).map((c: J) => para(c))),
    interventions: joined(list(ai.interventions).map((i: J) => para(`${i.type ? `${words(i.type)}: ` : ""}${i.name ?? ""}`))),
    primary_outcomes: list(om.primaryOutcomes).map(outcome).filter(Boolean), secondary_outcomes: list(om.secondaryOutcomes).length,
    eligibility: joined([el.sex ? `sex ${words(el.sex).toLowerCase()}` : null, age ? `age ${age}` : null, el.healthyVolunteers !== undefined ? `healthy volunteers ${el.healthyVolunteers ? "yes" : "no"}` : null]),
    locations: countries.length ? `${list(cl.locations).length} site${list(cl.locations).length === 1 ? "" : "s"} in ${countries.join(", ")}` : null,
    publications: refs.filter((r: J) => r.pmid && ["RESULT", "DERIVED"].includes(String(r.type))).map((r: J) => `pmid:${r.pmid}`),
    has_results: d.hasResults === true,
    summary: para(de.briefSummary, 400),
  };
}

// Collaborators: the first three names and how many more ("A; B; C +4") —
// the full list can run to 300+ chars; fh_library_read(nct, section: "Sponsor") has it.
export function collaboratorsLine(names: string[]): string | null {
  if (!names.length) return null;
  return names.slice(0, 3).join("; ") + (names.length > 3 ? ` +${names.length - 3}` : "");
}

export type ResultsText = { nct: string; has_results: boolean; text: string | null; truncated: boolean; outcomes: string[]; note: string | null };

// The "## Results" part of the stored Markdown, reordered for a review: the
// outcome measures first (primary before secondary, as stored), then adverse
// events, then the groups, participant flow and baseline. The group
// descriptions — repeated by the registry in flow, baseline and adverse
// events, often 1,500+ chars each time — come once, under "### Groups"; a
// group whose description differs between sections keeps it where it is.
// Capped at maxChars; the outcome titles listed so one can be read whole with
// fh_library_read(id, section). NCT02819440: the primaries started after 3,000
// chars as stored, after ~300 now.
const ORDER = ["Outcome measures", "Adverse events", "Groups", "Participant flow", "Baseline characteristics"];
export function reorderResults(part: string): string {
  const chunks = part.split(/^(?=### )/m).map((c) => c.trim()).filter(Boolean);
  const groups = new Map<string, string>();   // title → its bullet block, first seen
  const sections: { name: string; body: string }[] = [];
  for (const c of chunks) {
    const name = /^### (.+)$/m.exec(c)?.[1].trim() ?? "";
    const lines = c.split("\n").slice(1);
    // The group block: from the first "- **Title**" line up to the first table or bold measure title.
    let a = lines.findIndex((l) => /^- \*\*[^*]+\*\*/.test(l));
    let b = a < 0 ? -1 : lines.findIndex((l, i) => i > a && (/^\|/.test(l) || /^\*\*/.test(l) || /^#### /.test(l)));
    if (a >= 0 && b < 0) b = lines.length;
    if (a < 0) { sections.push({ name, body: lines.join("\n").trim() }); continue; }
    const kept: string[] = [];
    let cur: string[] = [];
    const flush = () => {
      if (!cur.length) return;
      const block = cur.join("\n").trim(); const title = /^- \*\*([^*]+)\*\*/.exec(block)![1];
      if (!groups.has(title)) groups.set(title, block);
      else if (groups.get(title) !== block) kept.push(block);
      cur = [];
    };
    for (const l of lines.slice(a, b)) { if (/^- \*\*[^*]+\*\*/.test(l)) flush(); cur.push(l); }
    flush();
    const body = [...lines.slice(0, a), ...kept, ...lines.slice(b)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
    sections.push({ name, body });
  }
  if (groups.size) sections.push({ name: "Groups", body: [...groups.values()].join("\n\n") });
  const rank = (n: string) => { const i = ORDER.indexOf(n); return i < 0 ? ORDER.length : i; };
  return sections.map((x, i) => ({ ...x, i })).sort((x, y) => rank(x.name) - rank(y.name) || x.i - y.i)
    .filter((x) => x.body).map((x) => `### ${x.name}\n\n${x.body}`).join("\n\n");
}

export function resultsText(nct: string, md: string, maxChars: number): ResultsText {
  const i = md.search(/^## Results\s*$/m);
  if (i < 0) return { nct, has_results: false, text: null, truncated: false, outcomes: [], note: "no posted results in the registry record" };
  const part = reorderResults(md.slice(i).replace(/^## Results\s*\n/, "").replace(/\n## [\s\S]*$/, "").trim());
  const outcomes = [...part.matchAll(/^#### (.+)$/gm)].map((m) => m[1].trim());
  const truncated = part.length > maxChars;
  return { nct, has_results: true, text: truncated ? part.slice(0, maxChars).trimEnd() + "\n\n[truncated]" : part, truncated, outcomes, note: truncated ? "cut at max_chars; fh_library_read(id, section: <an outcome title>) returns one measure whole" : null };
}
