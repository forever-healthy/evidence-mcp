import { fetchText, LIBRARY_UA } from "./http.js";
import { cellPipes } from "./text.js";

// ClinicalTrials.gov records (API v2, JSON, no key) → Markdown. One entry per
// NCT ID, always the current record; the last-update-posted date is its
// version. Every module becomes a section
// with its values in plain words — "Phase 2", "Active, not recruiting",
// "100 (estimated)" — so a figure a review states can be found as stated.
// Posted results are converted too: participant flow, baseline, outcome
// measures with their group values, adverse events.

export const CTGOV_PAGE = (nctid: string) => `https://clinicaltrials.gov/study/${nctid}`;
const API = (nctid: string) => `https://clinicaltrials.gov/api/v2/studies/${nctid}?format=json`;

export async function fetchStudy(nctid: string): Promise<string> {
  const json = await fetchText(API(nctid), { "User-Agent": LIBRARY_UA, Accept: "application/json" });
  if (!/"protocolSection"/.test(json.slice(0, 2000))) throw new Error("ctgov: not a study record");
  return json;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const STATUS: Record<string, string> = {
  NOT_YET_RECRUITING: "Not yet recruiting", RECRUITING: "Recruiting", ENROLLING_BY_INVITATION: "Enrolling by invitation",
  ACTIVE_NOT_RECRUITING: "Active, not recruiting", SUSPENDED: "Suspended", TERMINATED: "Terminated", COMPLETED: "Completed",
  WITHDRAWN: "Withdrawn", UNKNOWN: "Unknown status", AVAILABLE: "Available", NO_LONGER_AVAILABLE: "No longer available",
  TEMPORARILY_NOT_AVAILABLE: "Temporarily not available", APPROVED_FOR_MARKETING: "Approved for marketing", WITHHELD: "Withheld",
};
const PHASE: Record<string, string> = { EARLY_PHASE1: "Early Phase 1", PHASE1: "Phase 1", PHASE2: "Phase 2", PHASE3: "Phase 3", PHASE4: "Phase 4", NA: "Not applicable" };
// Any other enum: words, first letter up — QUADRUPLE → Quadruple, CARE_PROVIDER → Care provider.
export const words = (v: unknown): string => { const s = String(v ?? ""); if (!s) return ""; if (STATUS[s]) return STATUS[s]; if (PHASE[s]) return PHASE[s]; const w = s.toLowerCase().replace(/_/g, " "); return w.charAt(0).toUpperCase() + w.slice(1); };
const dated = (d: J): string => (d?.date ? `${d.date}${d.type ? ` (${String(d.type).toLowerCase()})` : ""}` : "");
const list = (a: J): J[] => (Array.isArray(a) ? a : []);
const row = (cells: string[]) => `| ${cells.map((c) => cellPipes(c).replace(/\s+/g, " ").trim()).join(" | ")} |`;
const table = (head: string[], rows: string[][]): string => rows.length ? [row(head), `| ${head.map(() => "---").join(" | ")} |`, ...rows.map(row)].join("\n") : "";
const para = (s: unknown): string => String(s ?? "").replace(/\r/g, "").trim();

export type StudyDoc = {
  nctid: string; title: string; acronym: string | null; sponsor: string | null;
  firstPosted: string | null; lastUpdate: string | null; status: string | null; hasResults: boolean;
  publications: string[];       // "pmid:…" of the references typed RESULT or DERIVED
  sections: string[];
};

export function parseStudy(json: string): StudyDoc | null {
  let d: J; try { d = JSON.parse(json); } catch { return null; }
  const ps = d?.protocolSection; if (!ps) return null;
  const idm = ps.identificationModule ?? {}, st = ps.statusModule ?? {}, sp = ps.sponsorCollaboratorsModule ?? {}, de = ps.descriptionModule ?? {};
  const dm = ps.designModule ?? {}, ai = ps.armsInterventionsModule ?? {}, om = ps.outcomesModule ?? {}, el = ps.eligibilityModule ?? {}, cl = ps.contactsLocationsModule ?? {}, rf = ps.referencesModule ?? {};
  const nctid = String(idm.nctId ?? "").toUpperCase();
  const out: string[] = [];
  const sec = (title: string, lines: (string | null | undefined | false)[]) => { const body = lines.filter((l): l is string => !!l && l.trim() !== ""); if (body.length) out.push(`## ${title}`, ...body); };

  const secondary = list(idm.secondaryIdInfos).map((s: J) => `${words(s.type)}${s.domain ? ` (${s.domain})` : ""}: ${s.id}`);
  sec("Identification", [
    idm.officialTitle ? `Official title: ${para(idm.officialTitle)}` : null,
    idm.acronym ? `Acronym: ${idm.acronym}` : null,
    idm.organization?.fullName ? `Organization: ${idm.organization.fullName}` : null,
    secondary.length ? `Secondary IDs: ${secondary.join("; ")}` : null,
  ]);
  sec("Status", [
    `Overall status: ${words(st.overallStatus)}${st.whyStopped ? ` — why stopped: ${para(st.whyStopped)}` : ""}`,
    st.startDateStruct ? `Start: ${dated(st.startDateStruct)}` : null,
    st.primaryCompletionDateStruct ? `Primary completion: ${dated(st.primaryCompletionDateStruct)}` : null,
    st.completionDateStruct ? `Completion: ${dated(st.completionDateStruct)}` : null,
    st.studyFirstPostDateStruct ? `First posted: ${dated(st.studyFirstPostDateStruct)}` : null,
    st.lastUpdatePostDateStruct ? `Last update posted: ${dated(st.lastUpdatePostDateStruct)}` : null,
    st.statusVerifiedDate ? `Status verified: ${st.statusVerifiedDate}` : null,
    `Results posted: ${d.hasResults ? "yes" : "no"}`,
  ]);
  const rp = sp.responsibleParty;
  sec("Sponsor and collaborators", [
    sp.leadSponsor?.name ? `Lead sponsor: ${sp.leadSponsor.name}${sp.leadSponsor.class ? ` (${words(sp.leadSponsor.class).toLowerCase()})` : ""}` : null,
    list(sp.collaborators).length ? `Collaborators: ${list(sp.collaborators).map((c: J) => c.name).join("; ")}` : null,
    rp ? `Responsible party: ${[words(rp.type).toLowerCase(), rp.investigatorFullName, rp.investigatorTitle, rp.investigatorAffiliation].filter(Boolean).join(", ")}` : null,
  ]);
  sec("Description", [de.briefSummary ? para(de.briefSummary) : null, de.detailedDescription ? para(de.detailedDescription) : null]);
  sec("Conditions", [list(ps.conditionsModule?.conditions).length ? list(ps.conditionsModule.conditions).join("; ") : null, list(ps.conditionsModule?.keywords).length ? `Keywords: ${list(ps.conditionsModule.keywords).join("; ")}` : null]);
  const di = dm.designInfo ?? {}; const mi = di.maskingInfo ?? {};
  sec("Design", [
    dm.studyType ? `Study type: ${words(dm.studyType)}` : null,
    list(dm.phases).length ? `Phase: ${list(dm.phases).map(words).join(", ")}` : null,
    di.allocation ? `Allocation: ${words(di.allocation)}` : null,
    di.interventionModel ? `Intervention model: ${words(di.interventionModel)}${di.interventionModelDescription ? ` — ${para(di.interventionModelDescription)}` : ""}` : null,
    di.primaryPurpose ? `Primary purpose: ${words(di.primaryPurpose)}` : null,
    mi.masking ? `Masking: ${words(mi.masking)}${list(mi.whoMasked).length ? ` (${list(mi.whoMasked).map((w: J) => words(w).toLowerCase()).join(", ")})` : ""}${mi.maskingDescription ? ` — ${para(mi.maskingDescription)}` : ""}` : null,
    dm.enrollmentInfo?.count !== undefined ? `Enrollment: ${dm.enrollmentInfo.count}${dm.enrollmentInfo.type ? ` (${String(dm.enrollmentInfo.type).toLowerCase()})` : ""}` : null,
  ]);
  const arms = list(ai.armGroups).map((a: J) => `- **${a.label}**${a.type ? ` (${words(a.type).toLowerCase()})` : ""}${a.description ? `: ${para(a.description)}` : ""}${list(a.interventionNames).length ? ` — ${list(a.interventionNames).join("; ")}` : ""}`);
  const ints = list(ai.interventions).map((i: J) => `- **${words(i.type)}: ${i.name}**${list(i.otherNames).length ? ` (${list(i.otherNames).join(", ")})` : ""}${i.description ? `: ${para(i.description)}` : ""}${list(i.armGroupLabels).length ? ` — arms: ${list(i.armGroupLabels).join("; ")}` : ""}`);
  sec("Arms and interventions", [arms.length ? "Arms:" : null, ...arms, ints.length ? "Interventions:" : null, ...ints]);
  const outcome = (o: J) => `- **${para(o.measure)}**${o.description ? `: ${para(o.description)}` : ""}${o.timeFrame ? ` Time frame: ${para(o.timeFrame)}.` : ""}`;
  sec("Outcomes", [
    list(om.primaryOutcomes).length ? "### Primary outcomes" : null, ...list(om.primaryOutcomes).map(outcome),
    list(om.secondaryOutcomes).length ? "### Secondary outcomes" : null, ...list(om.secondaryOutcomes).map(outcome),
    list(om.otherOutcomes).length ? "### Other outcomes" : null, ...list(om.otherOutcomes).map(outcome),
  ]);
  sec("Eligibility", [
    [el.sex ? `Sex: ${words(el.sex).toLowerCase()}` : "", el.minimumAge || el.maximumAge ? `Age: ${el.minimumAge ?? "no minimum"} to ${el.maximumAge ?? "no maximum"}` : "", el.healthyVolunteers !== undefined ? `Healthy volunteers: ${el.healthyVolunteers ? "yes" : "no"}` : ""].filter(Boolean).join(" · "),
    el.eligibilityCriteria ? para(el.eligibilityCriteria) : null,
  ]);
  const countries = [...new Set(list(cl.locations).map((l: J) => l.country).filter(Boolean))] as string[];
  sec("Locations", [countries.length ? `${list(cl.locations).length} sites in ${countries.join(", ")}` : null, list(cl.overallOfficials).length ? `Overall officials: ${list(cl.overallOfficials).map((o: J) => [o.name, o.role ? words(o.role).toLowerCase() : "", o.affiliation].filter(Boolean).join(", ")).join("; ")}` : null]);
  const refs = list(rf.references);
  sec("References", refs.map((r: J) => `- ${para(r.citation)}${r.pmid ? ` pmid:${r.pmid}` : ""}${r.type ? ` (${words(r.type).toLowerCase()})` : ""}`));
  const publications = refs.filter((r: J) => r.pmid && ["RESULT", "DERIVED"].includes(String(r.type))).map((r: J) => `pmid:${r.pmid}`);

  if (d.hasResults && d.resultsSection) out.push(...results(d.resultsSection));

  return {
    nctid, title: para(idm.briefTitle) || nctid, acronym: idm.acronym ?? null, sponsor: sp.leadSponsor?.name ?? null,
    firstPosted: st.studyFirstPostDateStruct?.date ?? null, lastUpdate: st.lastUpdatePostDateStruct?.date ?? null,
    status: st.overallStatus ? words(st.overallStatus) : null, hasResults: !!d.hasResults, publications, sections: out,
  };
}

// Posted results: the groups once, then every outcome measure as a table
// (groups across, categories down), participant flow and baseline as tables,
// adverse events as tables with affected / at risk per group.
function results(rs: J): string[] {
  const out: string[] = ["## Results"];
  const pf = rs.participantFlowModule;
  if (pf) {
    out.push("### Participant flow");
    const groups = list(pf.groups);
    out.push(...groups.map((g: J) => `- **${g.title}**${g.description ? `: ${para(g.description)}` : ""}`));
    if (pf.recruitmentDetails) out.push(para(pf.recruitmentDetails));
    for (const p of list(pf.periods)) {
      const head = ["Period: " + (p.title ?? ""), ...groups.map((g: J) => g.title)];
      const rows = list(p.milestones).map((m: J) => [words(m.type), ...groups.map((g: J) => list(m.achievements).find((a: J) => a.groupId === g.id)?.numSubjects ?? "")]);
      for (const dw of list(p.dropWithdraws)) rows.push([`Not completed: ${dw.type}`, ...groups.map((g: J) => list(dw.reasons).find((r: J) => r.groupId === g.id)?.numSubjects ?? "")]);
      out.push(table(head, rows));
    }
  }
  const bc = rs.baselineCharacteristicsModule;
  if (bc) {
    out.push("### Baseline characteristics");
    const groups = list(bc.groups);
    out.push(...groups.map((g: J) => `- **${g.title}**${g.description ? `: ${para(g.description)}` : ""}`));
    for (const m of list(bc.measures)) {
      const unit = [m.paramType ? words(m.paramType).toLowerCase() : "", m.dispersionType ? words(m.dispersionType).toLowerCase() : "", m.unitOfMeasure].filter(Boolean).join(", ");
      const rows: string[][] = [];
      for (const c of list(m.classes)) for (const cat of list(c.categories)) rows.push([[c.title, cat.title].filter(Boolean).join(" — ") || m.title, ...groups.map((g: J) => { const x = list(cat.measurements).find((v: J) => v.groupId === g.id); return x ? `${x.value ?? ""}${x.spread !== undefined ? ` ± ${x.spread}` : ""}${x.lowerLimit !== undefined ? ` (${x.lowerLimit} to ${x.upperLimit})` : ""}` : ""; })]);
      out.push(`**${m.title}**${unit ? ` (${unit})` : ""}`, table(["", ...groups.map((g: J) => g.title)], rows));
    }
  }
  const om = rs.outcomeMeasuresModule;
  if (om) {
    out.push("### Outcome measures");
    for (const m of list(om.outcomeMeasures)) {
      const groups = list(m.groups);
      const unit = [m.paramType ? words(m.paramType).toLowerCase() : "", m.dispersionType ? String(m.dispersionType).toLowerCase() : "", m.unitOfMeasure].filter(Boolean).join(", ");
      out.push(`#### ${m.title}${m.type ? ` (${words(m.type).toLowerCase()})` : ""}`);
      if (m.description) out.push(para(m.description));
      out.push([m.timeFrame ? `Time frame: ${para(m.timeFrame)}.` : "", unit ? `Measure: ${unit}.` : "", m.populationDescription ? `Population: ${para(m.populationDescription)}` : ""].filter(Boolean).join(" "));
      if (m.reportingStatus && m.reportingStatus !== "POSTED") out.push(`Reporting status: ${words(m.reportingStatus)}.`);
      const rows: string[][] = [];
      for (const c of list(m.classes)) for (const cat of list(c.categories)) rows.push([[c.title, cat.title].filter(Boolean).join(" — ") || m.title, ...groups.map((g: J) => { const x = list(cat.measurements).find((v: J) => v.groupId === g.id); return x ? `${x.value ?? ""}${x.spread !== undefined ? ` ± ${x.spread}` : ""}${x.lowerLimit !== undefined ? ` (${x.lowerLimit} to ${x.upperLimit})` : ""}` : ""; })]);
      const denoms = list(m.denoms).flatMap((dn: J) => list(dn.counts)).filter((c: J) => c.groupId);
      if (denoms.length) rows.unshift(["Participants analysed", ...groups.map((g: J) => denoms.find((c: J) => c.groupId === g.id)?.value ?? "")]);
      out.push(table(["", ...groups.map((g: J) => g.title)], rows));
      for (const a of list(m.analyses)) out.push(`Analysis${a.groupDescription ? ` (${para(a.groupDescription)})` : ""}: ${[a.statisticalMethod, a.pValue !== undefined ? `p ${a.pValueComment ?? ""}${a.pValue}`.trim() : "", a.paramType ? `${words(a.paramType).toLowerCase()} ${a.paramValue ?? ""}` : "", a.ciPctValue ? `${a.ciPctValue}% CI ${a.ciLowerLimit ?? ""} to ${a.ciUpperLimit ?? ""}` : ""].filter(Boolean).join("; ")}`);
    }
  }
  const ae = rs.adverseEventsModule;
  if (ae) {
    out.push("### Adverse events");
    const groups = list(ae.eventGroups);
    out.push([ae.timeFrame ? `Time frame: ${para(ae.timeFrame)}.` : "", ae.frequencyThreshold ? `Threshold for other events: ${ae.frequencyThreshold}%.` : "", ae.description ? para(ae.description) : ""].filter(Boolean).join(" "));
    const summary = [
      ["Serious events, participants affected / at risk", ...groups.map((g: J) => `${g.seriousNumAffected ?? ""} / ${g.seriousNumAtRisk ?? ""}`)],
      ["Other events, participants affected / at risk", ...groups.map((g: J) => `${g.otherNumAffected ?? ""} / ${g.otherNumAtRisk ?? ""}`)],
      ["Deaths, participants affected / at risk", ...groups.map((g: J) => g.deathsNumAffected !== undefined ? `${g.deathsNumAffected} / ${g.deathsNumAtRisk ?? ""}` : "")],
    ].filter((r) => r.slice(1).some(Boolean));
    out.push(table(["", ...groups.map((g: J) => g.title)], summary));
    const events = (title: string, evs: J[]) => { if (!evs.length) return; out.push(`**${title}** (participants affected / at risk)`, table(["Event", "System", ...groups.map((g: J) => g.title)], evs.map((e: J) => [e.term ?? "", e.organSystem ?? "", ...groups.map((g: J) => { const s = list(e.stats).find((x: J) => x.groupId === g.id); return s ? `${s.numAffected ?? ""} / ${s.numAtRisk ?? ""}` : ""; })]))); };
    events("Serious adverse events", list(ae.seriousEvents));
    events("Other adverse events", list(ae.otherEvents));
  }
  return out;
}

export function headLineStudy(s: StudyDoc): string {
  return [s.sponsor, s.nctid, s.status ? s.status.toLowerCase() : "", s.firstPosted ? `first posted ${s.firstPosted}` : "", s.lastUpdate ? `last update posted ${s.lastUpdate}` : "", CTGOV_PAGE(s.nctid)].filter(Boolean).join(" · ");
}

export function renderStudyMd(s: StudyDoc): string {
  const parts = [`# ${s.title}${s.acronym ? ` (${s.acronym})` : ""} — ClinicalTrials.gov record`, "", headLineStudy(s), "", ...s.sections.flatMap((b) => [b, ""])];
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
