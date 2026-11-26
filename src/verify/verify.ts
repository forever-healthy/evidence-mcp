import { existsSync, readFileSync } from "node:fs";
import { entryExists, readMeta, NOTHING_TO_VERIFY } from "../entry.js";
import { parseId } from "../ids.js";
import { entryPaths, FH_EVIDENCE_DIR } from "../layout.js";
import { UNRESOLVED_GLYPH } from "../pdf.js";
import { CORRECTED_HEADING } from "../entry.js";
import type { VerifyConfig } from "./config.js";
import type { Decide } from "./decider.js";

// fh_verify_claim(claim, id): is one finding of a review stated by one paper
// it cites? One claim, one paper per call — a finding cited to three papers
// is three calls with the same claim, three rows in the audit, and a fixer
// can drop the one source that does not carry it. No aggregation here.
// Judged by a decision model through a Decisions API: "noul" questions,
// P(true) back, no quotes, no prose (the design notes at the end of this file
// for the decisions). The providers — Perplexity, Google — are one file each
// next to this one; config.ts picks one from FH_VERIFY_URL, decider.ts sends.

// The one question, chosen on planted claims and on real review sentences
// (design notes at the end of this file): a changed number must fall, a rounded one must stand,
// and a section label or a definition in parentheses must not count.
export const QUESTION = "Does the paper state this, in substance? Ignore section labels and definitions of terms in parentheses. Every fact and number of the statement must be stated in the paper or follow from its numbers; a rounded number counts. If any part of the statement is absent from the paper or contradicted by it, answer false.";

// Markdown as the model sees it: link targets and images dropped (a publisher
// page's URLs cost more tokens than its prose), navigation headings dropped.
export function cleanMarkdown(md: string): string {
  return paperYearOnly(dropReferences(md))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/^\s*#+\s*(see more about|more for you|back to top)\b.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n");
}

// The reference list is not sent: it states no finding of this paper, only
// other papers' titles — a claim could pass on a cited title ("tadalafil
// improves erectile function") — and it is 22% of what a full text sent
// (AI4L's library, 92 full texts, 2026-11-09). Dropped from a heading
// "References" / "Bibliography" / "Literature cited" (any level, or a bare line
// as PDFs and publisher pages write it) to the next heading of the same or a
// higher level, or the end. On disk and in fh_library_read the list stays. A PDF
// whose list follows the last section without any such line (6 of 92) keeps it.
const REF_HEAD = /^(#{1,6})\s*\**\s*(references|bibliography|literature cited|reference list|works cited|cited literature)\b[^\n]*$|^\**(references|bibliography|literature cited)\**:?[ \t]*$/gim;
export function dropReferences(md: string): string {
  let out = md;
  for (;;) {
    REF_HEAD.lastIndex = 0;
    const m = REF_HEAD.exec(out);
    if (!m) return out;
    const level = m[1]?.length ?? 6;   // a bare line: up to the next heading of any level
    const rest = out.slice(m.index + m[0].length);
    const next = new RegExp(`^#{1,${level}}\\s`, "m").exec(rest);
    out = out.slice(0, m.index) + (next ? rest.slice(next.index) : "");
  }
}

// A paper's citation line under its title — authors · journal · year · PMID ·
// DOI — down to the year: a claim names no source (citations are refused),
// so authors, journal and IDs tell the decider nothing; the year can date a
// finding. 10% of an abstract (212 abstracts, up to 1,600 chars of consortium
// authors). Only a paper's line (it carries a PMID or DOI): a label's line
// keeps its labeller, version and approval year.
export function paperYearOnly(md: string): string {
  return md.replace(/^(#[^\n]*\n\n)([^\n]*· (?:PMID \d+|DOI 10\.)[^\n]*)$/m, (_, title: string, line: string) => {
    const year = / · (\d{4})(?: · |$)/.exec(line)?.[1];
    return year ? `${title}${year}` : title.trimEnd();
  });
}

// The paper in windows of at most `max` characters, cut at headings, so a
// long paper fits the model's request (the Mac app's 32k tokens, d1-ultra's
// 32k); the claim is judged against each window and the highest P(true)
// counts. Raising the app's limit instead does not pay: one 50k-token request
// did not answer in five minutes where two 25k windows take 25 s.
// - A section longer than a window is split at its paragraphs, and the next
//   piece starts with the last paragraph again, so a finding at a cut is whole
//   in one of them (until 2026-11-16 it was cut off at `max`: pmid:18843650,
//   328,486 characters, sent 60% of its text in 3 windows).
// - Every window after the first starts with the paper's title and abstract
//   (at most a quarter of the window): its core findings beside each part, for
//   a claim that joins a methods detail to a result.
export function windows(md: string, max: number): string[] {
  const secs = cleanMarkdown(md).split(/\n(?=#)/);
  const whole = secs.join("\n");
  if (whole.length <= max) return [whole];
  const title = secs[0]?.startsWith("# ") ? secs[0] : "";
  const abstract = secs.find((x) => /^#+\s*(abstract|summary)\b/i.test(x)) ?? "";
  const head = [title, abstract].filter((x, i, all) => x && all.indexOf(x) === i).join("\n").slice(0, Math.floor(max / 4));
  const room = max - (head ? head.length + 1 : 0);
  const pieces = secs.flatMap((x) => (x.length <= room ? [x] : splitSection(x, room)));
  const out: string[] = [];
  let cur = "";
  for (const x of pieces) {
    if (cur && cur.length + x.length + 1 > room) { out.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + x;
  }
  if (cur) out.push(cur);
  return out.map((w, i) => (i > 0 && head ? `${head}\n${w}` : w));
}

// A section too long for one window, in pieces of at most `room` at its
// paragraphs; each piece after the first repeats the paragraph before the cut
// (when it is short enough to repeat). A paragraph longer than a piece is cut
// in slices that overlap by 500 characters (a quarter of a small window).
function splitSection(section: string, room: number): string[] {
  const paras = section.split(/\n{2,}/).flatMap((p) => {
    if (p.length <= room) return [p];
    const slices: string[] = [];
    const step = room - Math.min(500, Math.floor(room / 4));   // the overlap: 500 characters, a quarter of a small window
    for (let i = 0; i < p.length; i += step) slices.push(p.slice(i, i + room));
    return slices;
  });
  const out: string[] = [];
  let cur: string[] = [];
  const len = (ps: string[]) => ps.reduce((n, p) => n + p.length + 2, 0);
  for (const p of paras) {
    if (cur.length && len(cur) + p.length > room) {
      out.push(cur.join("\n\n"));
      const last = cur[cur.length - 1];
      cur = last.length <= room / 4 && last.length + p.length + 2 <= room ? [last] : [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur.join("\n\n"));
  return out;
}

// A citation group: a parenthesis or bracket holding author names and a year,
// "(Kloner et al., 2004; Guillaume et al., 2007)" or "[Brock et al., 2014]";
// adjacent groups separated only by punctuation or "and" count as one. The
// claim must name no source at all — the paper is the id — so any group is
// refused; two groups also mean two findings, which the auditor splits.
// A date in brackets — "(August 2014)", "(March 2026)" — is not a source: a
// group needs a capitalised word that is not a month (an author's name). Found
// 2026-11-11: trial-status claims ("its estimated completion (August 2014) has
// passed") refused as naming a source.
const MONTH = /^(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|June?|July?|Aug(ust)?|Sep(t(ember)?)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\.?$/;
const namesAuthor = (group: string) => (group.match(/\b[A-Z][\p{L}'’-]+/gu) ?? []).some((w) => !MONTH.test(w));
export function citationGroups(claim: string): string[] {
  const one = /[(\[][^()\[\]]*?\b(1[89]\d\d|20\d\d)[a-z]?\b[^()\[\]]*[)\]]/g;
  const groups: string[] = [];
  let last = -1;
  for (const m of claim.matchAll(one)) {
    if (!namesAuthor(m[0])) continue;
    const between = claim.slice(last, m.index!);
    if (last >= 0 && /^[\s;,]*(and|&)?[\s;,]*$/i.test(between)) { groups[groups.length - 1] += between + m[0]; }
    else groups.push(m[0]);
    last = m.index! + m[0].length;
  }
  return groups;
}

// A fragment left by a careless split: the claim starts with a conjunction or
// a relative word once list bullets and a bold label are stripped ("and
// dementia", "or silodosin", "which lowered …"). The auditor restores the subject and sends a statement.
export function fragment(claim: string): string | null {
  const body = claim.trim().replace(/^[-*+]\s+/, "").replace(/^\*\*[^*]+:\*\*\s*/, "").replace(/^[("'\u201c]+/, "");
  const first = /^(\S+)/.exec(body)?.[1] ?? "";
  // "OR 2.15 (95% CI 1.06 to 4.34) for acute NAION …" is an odds ratio, not the
  // conjunction: all-caps OR followed by a figure, "=", "(" or "of"/"for" stands (found 2026-11-08, pmid:25358826).
  const oddsRatio = first === "OR" && /^OR\s+(\d|=|\(|of\b|for\b)/.test(body);
  if (!oddsRatio && /^(and|or|but|nor|which|whereas|while)$/i.test(first.replace(/[,;:]$/, ""))) return `claim is a fragment: starts with "${first}" — send a complete statement with its subject`;
  // No lowercase rule: "pemetrexed requires …", "hs-CRP fell …", "all 101 participants …" are statements.
  // Of 47 claims it refused on live and dev, nearly all were (#61); the decision model judges the content.
  return null;
}

// A correction of the paper's figures is stored ("Corrected in PubMed
// abstract"): does the claim use a figure the correction replaced? Asked only
// for such papers, against the corrected sentences alone.
export const SUPERSEDED = "The corrected text replaces figures that the paper first published wrongly. Does the statement give a figure for a quantity the corrected text also gives, but with a different value — the superseded, uncorrected figure? If the statement's figures match the corrected text, or it concerns something the corrected text does not cover, answer false.";
export function correctedText(md: string): string | null {
  const i = md.indexOf(`\n${CORRECTED_HEADING}\n`);
  if (i < 0) return null;
  return md.slice(i + CORRECTED_HEADING.length + 2).split("\n").filter((l) => l.trim() && !/^NLM corrected these sentences/.test(l)).join("\n").trim() || null;
}

export type Basis = "full_text" | "abstract" | "title";   // title: PubMed has no abstract text and no full text was found
export type VerifyResult = {
  claim: string;
  id: string;
  verdict: "supported" | "not_supported" | "unverifiable" | "error";
  reason: string | null;         // a fail on a title-only record, or unverifiable: why, in one fixed sentence
  score: number | null;          // P(the paper states the finding)
  basis: Basis | null;           // what of the paper was read
  windows: number;               // model requests over the paper (1 unless windowed)
  glyphs_unresolved: number;     // numbers of the claim that stand next to a symbol the PDF's font lost (−, ±, ≤ …) in the full text: above 0, this verdict touched a lost symbol
  superseded: boolean | null;    // the claim uses a figure a stored correction replaced; null when the paper has no stored correction
  model: string | null;
  error?: string;
};

export type Paper = { id: string; basis: Basis; text: string; abstract?: string } | { id: string; error: string };   // abstract: beside a full text, the record with PubMed's abstract

export async function readPaper(raw: string, libraryDir = FH_EVIDENCE_DIR): Promise<Paper> {
  const p = parseId(raw);
  if (p.error) return { id: p.requested, error: p.error };
  const paths = entryPaths(libraryDir, p.type!, p.id!);
  if (!entryExists(paths)) return { id: p.requested, error: "not in library" };
  const full = existsSync(paths.fulltextMd);
  const meta = readMeta(paths);
  if (full) return { id: p.requested, basis: "full_text", text: readFileSync(paths.fulltextMd, "utf8"), ...(meta.has_abstract && existsSync(paths.md) ? { abstract: readFileSync(paths.md, "utf8") } : {}) };
  return { id: p.requested, basis: meta.has_abstract ? "abstract" : "title", text: readFileSync(paths.md, "utf8") };
}

// A lost symbol (#95). A PDF font without a character map leaves a control character where the
// minus, ±, ≤ … was; the decision model reads "\u00010.40" and a correct "−0.40" comes back
// not_supported. Whether a verdict touched one is decided in the text, without the model: a
// number of the claim stands directly next to a lost symbol. Numbers compare loosely (0.4 = 0.40).
const numKey = (n: string) => { const x = n.replace(",", "."); return x.includes(".") ? x.replace(/0+$/, "").replace(/\.$/, "") : x; };
const CTRL = UNRESOLVED_GLYPH.source;
export function glyphsAtClaim(claim: string, text: string): number {
  const mine = new Set((claim.match(/\d+(?:[.,]\d+)?/g) ?? []).map(numKey));
  if (!mine.size) return 0;
  let n = 0;
  for (const m of text.matchAll(new RegExp(`${CTRL}\\s?(\\d+(?:[.,]\\d+)?)|(\\d+(?:[.,]\\d+)?)\\s?${CTRL}`, "g"))) if (mine.has(numKey(m[1] ?? m[2]))) n++;
  return n;
}
// The claim without the symbols a font can lose, where they stand before a number; the text without the lost ones.
// A sign only where it is one (not the hyphen of "5-10 mg" or "IL-6"); a relation anywhere before a number.
export const withoutSymbols = (claim: string) => claim.replace(/(?<![\p{L}\p{N}])[\u2212\u2013+-]\s?(?=\.?\d)/gu, "").replace(/[\u00b1\u2264\u2265<>=~\u2248]\s?(?=\.?\d)/g, " ").replace(/\s+/g, " ").trim();
export const LOST_SYMBOL = "the claim's number is in the text, but the PDF's font lost the symbol next to it (−, ±, ≤ …): its sign or relation cannot be read";

// The verdict for one paper:
//   pass    P(true) reaches the threshold
//   fail    the full text was read and does not state it; or only the title
//           is there (no abstract, no full text): nothing to read, so nothing
//           can back the claim — no model call, reason says so
//   unverifiable  only the abstract was read and does not state it — the
//                 finding may be in the full text the library does not have;
//                 reason says so
//   A not_supported from a full text where a number of the claim stands next to a lost
//   symbol is decided again: the abstract (PubMed's, no lost symbols) states it — supported,
//   basis abstract; else the claim and the text without the symbols — supported there means the
//   number is right and only its symbol unreadable: unverifiable, reason says so.
//   error         the call cannot run: claim empty, names a source or is
//                 compound; paper not in the library; no model; model failing
export async function verifyClaim(claim: string, id: string, cfg: VerifyConfig | null, decide: Decide | null, read: (id: string) => Paper | Promise<Paper> = readPaper): Promise<VerifyResult> {
  const out: VerifyResult = { claim, id, verdict: "error", reason: null, score: null, basis: null, windows: 0, glyphs_unresolved: 0, superseded: null, model: cfg?.model ?? null };
  const words = claim.trim().split(/\s+/).filter(Boolean).length;
  if (!words) return { ...out, error: "claim empty" };
  // Three words make a finding ("Folate lowers homocysteine", "PPI-1011 is investigational"); two do not ("Visual recovery").
  if (words < 3) return { ...out, error: "claim too short to be a finding" };
  const frag = fragment(claim);
  if (frag) return { ...out, error: frag };
  const groups = citationGroups(claim);
  if (groups.length) return { ...out, error: groups.length > 1 ? `compound claim: ${groups.length} citation groups ${groups.join(" ")} — one finding per call, without its sources` : `claim names a source ${groups[0]} — send the finding without its sources; the paper is the id` };
  const paper = await read(id);
  out.id = paper.id;
  if ("error" in paper) return { ...out, error: paper.error };
  if (!cfg || !decide) return { ...out, error: "no decision model configured: set FH_VERIFY_PROVIDER and its API key in .env" };
  out.basis = paper.basis;
  out.glyphs_unresolved = paper.basis === "full_text" ? glyphsAtClaim(claim, paper.text) : 0;
  if (paper.basis === "title") return { ...out, verdict: "not_supported", reason: NOTHING_TO_VERIFY };
  const ws = windows(paper.text, cfg.window_chars);
  out.windows = ws.length;
  try {
    let score = 0;
    for (const w of ws) {
      const a = await decide({ paper: w, statement: claim }, { backed: { type: "noul", instructions: QUESTION } });
      score = Math.max(score, a.backed?.noul ?? 0);
    }
    out.score = score;
    const corrected = correctedText(paper.text);
    if (corrected) {
      const a = await decide({ corrected, statement: claim }, { superseded: { type: "noul", instructions: SUPERSEDED } });
      out.superseded = (a.superseded?.noul ?? 0) >= 0.5;
    }
  } catch (e) {
    return { ...out, error: e instanceof Error ? e.message : String(e) };
  }
  if (out.score! >= cfg.threshold) return { ...out, verdict: "supported" };
  if (paper.basis === "full_text" && out.glyphs_unresolved > 0) {
    try {
      if (paper.abstract) {
        let score = 0;
        for (const w of windows(paper.abstract, cfg.window_chars)) { out.windows++; score = Math.max(score, (await decide({ paper: w, statement: claim }, { backed: { type: "noul", instructions: QUESTION } })).backed?.noul ?? 0); }
        if (score >= cfg.threshold) return { ...out, verdict: "supported", score, basis: "abstract" };
      }
      const bare = withoutSymbols(claim);
      let score = 0;
      for (const w of windows(paper.text.replace(UNRESOLVED_GLYPH, ""), cfg.window_chars)) { out.windows++; score = Math.max(score, (await decide({ paper: w, statement: bare }, { backed: { type: "noul", instructions: QUESTION } })).backed?.noul ?? 0); }
      if (score >= cfg.threshold) return { ...out, verdict: "unverifiable", reason: LOST_SYMBOL };
    } catch (e) {
      return { ...out, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return paper.basis === "full_text" ? { ...out, verdict: "not_supported" } : { ...out, verdict: "unverifiable", reason: "only the abstract is stored and it does not state the claim; the full text may" };
}

// ---- Design notes: Claim verification — decisions, measurements, history ----
//
// This is the why behind it, what was measured, and what was tried and dropped
// (2026-11-04/05; code in `src/verify/`).
//
// ### Why
//
// AI4L's audit step 4 lists every finding of a review that cites a paper and
// asks whether the finding is, in substance, stated by the paper. The auditor
// never reads papers. The server reads them and asks a decision model,
// statement versus paper. The paper text leaves the machine when the model is
// hosted (the default); the Decider for Mac app keeps it local.
//
// ### Decisions
//
// - **Verdicts are cached as one file each under `verify/<2>/<4>/<key>.json`, the file system as the database** (2026-11-08, #26). Laid out like `url/`; a lookup is one stat, a write one atomic rename, nothing parsed but the one file. Not SQLite: `node:sqlite` needs Node 22.13 where the package promises 18, better-sqlite3 is a native build for every npx user. Key = first 16 hex of SHA-1(folded claim, source ID, model, threshold, hash of the stored text) — folding is NFKC, case, whitespace, quotes, dashes, ± forms, trailing period, nothing lexical (#33: of 156 claims in a repeat audit, 65 hit byte-identical and 91 were reworded; typography is the part the library can absorb, rewording is the prompt's); a hit must be younger than `FH_REFRESH_AFTER_DAYS`, an expired file is rewritten in place. Several servers share one library: a file appears whole or not at all, two misses at once write the same content — no lock. Errors and title-only fails are not kept. `fh_info` and the TUI walk `verify/` and count nothing there (no meta files). `src/verify/cache.ts`.
// - **One claim, one paper per call** (2026-11-05). A finding cited to three
//   papers is three calls with the same claim and three rows in the audit:
//   every source in a citation group is offered as support for the finding,
//   so each is checked, and a fixer can drop the one that does not carry it.
//   No aggregation in the server — the earlier `ids[]` precedence (first
//   paper that backs it wins) hid a wrong second source, and the alternative
//   ("all must back it") would only have said 2 of 3 without naming which.
// - **The unit is the finding, not the sentence.** The first run sent whole
//   sentences; nine of 55 combined several findings, each with its own
//   citation group, and no single paper states such a sentence. The split is
//   the auditor's (it has the review); the server refuses a compound claim.
// - **A decision model, no quotes.** The model returns probabilities, no
//   prose, no locator. The auditor needs the verdict; the review already
//   names the paper.
// - **Perplexity's Decider** through the Decisions API (`POST
//   {base_url}/v1/decisions`): hosted `api.perplexity.ai`, `pplx-decider-v1.2`
//   (27B; a 50k-token paper in 2 s; 2 cents per million tokens), or the
//   Decider for Mac app on the home server (`pplx-decider-flash-v1.2`, 4B,
//   32k-token requests, text stays local). Same request, same answer. It is
//   not a chat model (no generation head, non-causal attention, readout at a
//   marker token) and does not run through LM Studio, Ollama or vLLM.
// - **Providers, one file each** (2026-11-12): Google launched Gemini
//   Decision 1 on 2026-11-11 with a Decisions API of the same shape (same
//   `noul` questions, same `answers`; path `/v1beta/decisions`, key in
//   `x-goog-api-key`, the state as `input` blocks). `src/verify/providers.ts`
//   picks the provider from `FH_VERIFY_URL`'s host, so the settings stay
//   `FH_VERIFY_*` for every provider; a new one is a file and one list entry.
//   Measured 2026-11-12 (`stuff/verify`, 22 claims on 5 papers, abstract and
//   full text): both 22/22 and the same verdict on every claim. Perplexity
//   (pplx-decider-v1.2) separates more sharply — true 0.98–1.00, false
//   0.00–0.04 — than Google (true 0.94–0.98, false 0.02–0.20, the high one a
//   claim checked against the wrong paper). Median per call: Google 456 ms,
//   Perplexity 583 ms; on Google's free tier (50,000 input tokens a minute)
//   one call in ten waited out the limit, up to 84 s. A small set of written
//   claims: every provider got it right.
// - **Real review sentences** (2026-11-13, `stuff/verify`: 276 claims of the
//   telmisartan review against its 72 sources; OpenAI and Nace's Drex Max
//   joined). Backed: Perplexity 265, OpenAI 257, Google 250, Drex Max 235; all
//   four agreed on 225, split on 44. By hand on the splits: Perplexity right on
//   every one checked. OpenAI (gpt-6-luna, 277 ms median, the fastest) scores
//   almost only 0 or 1 and failed three claims its source states nearly word
//   for word at 0.00–0.05 — a confident wrong fail with no sign to look again.
//   Drex Max (1.1 s median, the slowest) was alone in failing 26 claims, 20 of
//   them plain facts of the long FDA label ("protein-bound >99.5%": 0.21);
//   dropped as a provider. Google in between. Perplexity stays the default.
//
// ### What the model sees
//
// - `state: {paper, statement}`, one `noul` question (`QUESTION` in
//   src/verify/verify.ts). The paper's Markdown (fulltext.md, else abstract.md) with
//   link targets, images and page navigation dropped — a publisher page's
//   URLs cost more tokens than its prose (HOPPS: 69k tokens raw, 50k clean).
// - The question: "Does the paper state this, in substance? Ignore section
//   labels and definitions of terms in parentheses. Every fact and number of
//   the statement must be stated in the paper or follow from its numbers; a
//   rounded number counts. If any part of the statement is absent from the
//   paper or contradicted by it, answer false." The strict core because a
//   planted number must fall; the label clause because the review's
//   sentences carry "**Magnitude:**" and "(RR, the ratio of event rates)"
//   and those must not count against it. An earlier attribution clause
//   ("judge only the finding attributed to this paper") went with the
//   citations: a source-free claim needs none.
// - Hosted takes 256k tokens in one request, measured 2026-11-05: the whole
//   50k-token HOPPS paper in 2.0 s, P 0.998. The Mac app's limit is 32k
//   tokens: a paper over `window_chars` (default 90 000 characters there,
//   800 000 hosted) is cut at headings into windows, each one request, and
//   the highest scores count. Raising the app's `max_tokens` does not pay
//   (`max_tokens = 65536`: the one-line self-test 0.19 s, one 25k-token
//   window 13 s, the whole paper no answer in 60 s — and the self-test sent
//   right after it hangs too: the app serves one request at a time and keeps
//   working on a request after the client gave up). Leave it at 32768.
//
// ### Log line
//
// Verdict words: `pass` / `fail` / `unverifiable` / `error` (2026-11-05 to 2026-11-07 the third was `na`; before, backed / not_backed / unverifiable; the TUI still colours the old words). `reason` is one of two fixed sentences: on `fail` with basis title, "no abstract and no full text: nothing to verify" (no model call, score null; the record is not citable either); on `unverifiable`, "only the abstract is stored and it does not state the claim; the full text may".
//
// One line per call: the time first (zero-padded, `00.7s`), then verdict,
// basis, score, windows when more than one, and the whole claim after the bar.
// No provider (2026-11-14; logged as provider=… from 2026-11-12): it does not
// change between lines, fh_info and the TUI's decider line name it. The TUI colours the verdict green / red / yellow and drops the
// word "verdict=".
//
// ### Measurements
//
// Planted claims (flash on the Mac, then hosted 27B): HOPPS true claim 0.98 /
// 1.00, HOPPS false 0.03 / 0.01, unrelated 0.01 / 0.00; taurine planted
// "did not improve TTE" 0.04 / 0.01, "g about 0.4" (rounded) 0.64–0.82 /
// 0.97, "roughly half an SD" (derived) 0.84–0.89 / 0.64, "g = 0.80" 0.01 /
// 0.00; tadalafil "81% vs 35%" (abstract) 0.97 / 0.99, "71% vs 35%" 0.07 /
// 0.05; PAH "walk distance +43 m", number not in the abstract, 0.38 / 0.19;
// inside compound cited sentences HbA1c "3.50" 0.30 / 0.05 (true 2.50: 0.96
// / 1.00), RR of death "0.46" 0.32 / 0.10 (true 0.66: 0.96 / 1.00).
//
// Real sentences of the tadalafil review flagged by the first run: seven of
// eight are backed by their papers when read by hand; the strict wording
// alone scored them 0.04–0.32, the attribution-aware wording 0.62–0.96
// (flash) and 0.69–1.00 (hosted). Papers that do not carry the finding stay
// at 0.00–0.41 with the hosted model, which is right under one claim, one
// paper.
//
// Source-free claims, hosted, the final wording (2026-11-05): real findings
// backed 0.95–1.00 (81% vs 35%, IPSS −2.3/−2.2 with its label and
// definition, HbA1c −2.50, RR of death 0.66, stone RR 1.16, "g about 0.4");
// planted numbers 0.00–0.20 ("43 m" 0.20, "71%" 0.08, "g = 0.80" 0.00, HBO
// "improved more than sham" 0.01, HbA1c "3.50" 0.09, RR "0.46" 0.15). One
// miss: the derived paraphrase "roughly half a standard deviation" for
// g = 0.40 scores 0.46, just under the threshold — a looser derivation than
// the audit should accept anyway. A paper that does not carry the finding
// (Soulaidopoulos 2024 for the RR of death 0.66 cited to Jehle 2025) scores
// 0.03: fail, which under one claim, one paper is the right row.
// Hellstrom 2008 against "a semen analysis … detects reduced sperm counts":
// 0.09; its abstract reports a ≥50% drop in sperm concentration in 12.6%
// versus 2.1%, so the claim is weakly stated rather than wrong.
//
// A triage of the claim on its own (hosted, all 55 claims of the first run:
// 44 one finding, 9 several findings — the real compound sentences — 1
// synthesis, 1 fragment, two misses at low confidence) showed the model can
// tell a compound sentence or a label-only list item from a finding. Not
// kept: the guard refuses the compound case, and the rest is the auditor's.
//
// ### Tuning
//
// - Hosted, source-free claims: real findings 0.95 and up, planted numbers
//   0.20 and under. A `pass` under 0.7 or a `fail` over 0.3
//   deserves a look with `fh_library_read`.
// - `unverifiable` is not a failure of the claim: once a full text is stored,
//   verify again.
// - Tune `FH_VERIFY_THRESHOLD` first, the wording in src/verify/verify.ts
//   second; rerun the planted claims after either.
// - Hosted: about 2 s per call whatever the paper's length. The Mac app:
//   0.2 s for an abstract, 2–3 s for a paper in one window, 20–25 s in two.
//
// ### Not in scope
//
// Registry records and labels (not in the library). Deciding what the audit
// does with a verdict: that is the AI4L prompt's job. A chat-model backend.
// Splitting sentences on the server, or stripping citations from a claim:
// the auditor has the review and sends findings.
//
