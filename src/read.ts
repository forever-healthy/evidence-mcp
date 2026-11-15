// fh_library_read: the deliberate, small flow of paper text through the model's
// context. Works on the entry's Markdown (fulltext.md, else abstract.md):
// outline → section text → passages for a query. Never the whole paper, and
// never a whole paragraph either when the paragraph is a PDF-sourced section
// of 400 KB: a passage is a window around the matched terms (#18).

export type Section = {
  level: number;
  heading: string;   // as written
  label: string;     // heading, plus " [i/n]" when the same heading occurs n times (Cochrane's "Participants" ×12)
  start: number;     // line of the heading
  end: number;       // first line after the section (next heading of the same or a higher level)
  bodyEnd: number;   // first line of the first subheading inside, else end: the section's own text is start+1..bodyEnd
  words: number;     // of the whole section, subsections included
};

export type Outline = {
  text: "full_text" | "abstract";
  words: number;
  sections: { level: number; heading: string; words: number }[];
};

export function sections(md: string): Section[] {
  const lines = md.split("\n");
  const out: Section[] = [];
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, heading: m[2], label: m[2], start: i, end: lines.length, bodyEnd: lines.length, words: 0 });
  });
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (out[j].level <= out[i].level) { out[i].end = out[j].start; break; }
    }
    out[i].bodyEnd = i + 1 < out.length && out[i + 1].start < out[i].end ? out[i + 1].start : out[i].end;
    out[i].words = countWords(lines.slice(out[i].start + 1, out[i].end).join("\n"));
  }
  // Duplicate headings get a position label so the outline tells them apart
  // and `section` can name one of them.
  const seen = new Map<string, Section[]>();
  for (const s of out) { const k = s.heading.toLowerCase(); seen.set(k, [...(seen.get(k) ?? []), s]); }
  for (const group of seen.values()) if (group.length > 1) group.forEach((s, i) => { s.label = `${s.heading} [${i + 1}/${group.length}]`; });
  return out;
}

const countWords = (s: string) => (s.replace(/^#{1,6}\s+/gm, "").match(/\S+/g) ?? []).length;

// The level-1 heading is the paper's title, not a section: left out of the
// outline and of section matching.
export function outline(md: string, text: Outline["text"]): Outline {
  return { text, words: countWords(md), sections: sections(md).filter((s) => s.level > 1).map(({ level, label, words }) => ({ level, heading: label, words })) };
}

// The sections whose heading contains `name` (case-insensitive); among several
// matches the shortest heading wins ("results" → "Results", not "Results of the
// sensitivity analysis"), and all sections with that same heading are returned
// (one, or Cochrane's twelve). "Participants [3/12]" or "Participants [3]"
// names the third.
export function findSections(md: string, name: string): Section[] {
  let q = name.trim().toLowerCase().replace(/^#+\s*/, "");
  let index: number | null = null;
  const m = /^(.*?)\s*\[(\d+)(?:\/\d+)?\]$/.exec(q);
  if (m) { q = m[1]; index = Number(m[2]); }
  if (!q) return [];
  const hits = sections(md).filter((s) => s.level > 1 && s.heading.toLowerCase().includes(q)).sort((a, b) => a.heading.length - b.heading.length);
  if (!hits.length) return [];
  const same = hits.filter((s) => s.heading.toLowerCase() === hits[0].heading.toLowerCase()).sort((a, b) => a.start - b.start);
  if (index !== null) return same[index - 1] ? [same[index - 1]] : [];
  return same;
}

export type SectionText = {
  heading: string;       // the label
  words: number;         // the whole section, subsections included (as in the outline)
  text: string;          // the section's own text: up to its first subheading, capped at maxChars
  returned_words: number;
  truncated: boolean;
  subsections?: { heading: string; words: number }[];  // direct children, when the section has any: pick one next
};

export type Ambiguous = { ambiguous: { heading: string; words: number; first_line: string }[] };

// A parent heading answers its own text and the list of its subsections, not
// the whole subtree cut at maxChars: "Introduction" with eleven subsections
// used to come back as the first 6000 chars and "[truncated]" (#18).
export function readSection(md: string, name: string, maxChars: number): SectionText | Ambiguous | null {
  const found = findSections(md, name);
  if (!found.length) return null;
  const lines = md.split("\n");
  if (found.length > 1) {
    return { ambiguous: found.map((s) => ({ heading: s.label, words: s.words, first_line: (lines.slice(s.start + 1, s.end).find((l) => l.trim()) ?? "").trim().slice(0, 120) })) };
  }
  return sectionText(lines, found[0], sections(md), maxChars);
}

function sectionText(lines: string[], s: Section, all: Section[], maxChars: number): SectionText {
  const body = lines.slice(s.start + 1, s.bodyEnd).join("\n").trim();
  const truncated = body.length > maxChars;
  const text = truncated ? body.slice(0, maxChars) + "\n\n[truncated]" : body;
  const inside = all.filter((c) => c.start > s.start && c.start < s.end);
  const childLevel = Math.min(...inside.map((c) => c.level));
  const children = inside.filter((c) => c.level === childLevel).map((c) => ({ heading: c.label, words: c.words }));
  const out: SectionText = { heading: s.label, words: s.words, text, returned_words: countWords(truncated ? body.slice(0, maxChars) : body), truncated };
  if (children.length) out.subsections = children;
  return out;
}

// A full text without a "Declarations" section (PDF- or HTML-sourced) may still
// carry the statements under their own headings: funding, conflicts of
// interest, acknowledgements, ethics, contributions, data availability. Those
// sections assembled, so section "Declarations" answers on every source alike.
const DECLARATION = /fund|financ|conflict|competing|interest|disclos|support|acknowledg|declar|ethic|contribut|consent|availab|sponsor/i;

export function assembleDeclarations(md: string, maxChars: number): SectionText | null {
  const lines = md.split("\n");
  const parts = sections(md).filter((s) => s.level > 1 && DECLARATION.test(s.heading));
  if (!parts.length) return null;
  const body = parts.map((s) => `### ${s.label}\n\n${lines.slice(s.start + 1, s.bodyEnd).join("\n").trim()}`).join("\n\n");
  const truncated = body.length > maxChars;
  return {
    heading: "Declarations (assembled)",
    words: countWords(body),
    text: truncated ? body.slice(0, maxChars) + "\n\n[truncated]" : body,
    returned_words: countWords(truncated ? body.slice(0, maxChars) : body),
    truncated,
    subsections: parts.map((s) => ({ heading: s.label, words: s.words })),
  };
}

// ---- query ----------------------------------------------------------------

export type Passage = { section: string; text: string; matched?: string[]; clipped?: true };

export type SearchResult = {
  passages: Passage[];
  partial: boolean;         // no paragraph had every term; the passages are the best partial matches
  missing_terms: string[];  // query terms the searched text never uses, in any form
  more?: number;            // further matching passages past max_hits: a larger max_hits returns them
};

export const WINDOW_CHARS = 1000;

// Matching forgives surface form: Markdown markup is dropped ("t~max~" is
// tmax), case and accents are folded, hyphen and slash count as spaces
// ("LDL-C" matches "LDL C"), and a light stem joins "decreased" with
// "decrease", "reductions" with "reduction", "studies" with "study". A
// paragraph that holds every term wins; when none does, the paragraphs with
// the most distinct terms come back marked partial. A passage is the sentences
// around the matches, at most WINDOW_CHARS, so a 400 KB paragraph (a
// PDF-sourced section) yields one window, not the section.
export function search(md: string, query: string, maxHits: number, opts: { scope?: Section; window?: number } = {}): SearchResult {
  const window = opts.window ?? WINDOW_CHARS;
  const terms = [...new Set(tokens(query))];
  const stems = [...new Set(terms.map(stem))];
  if (!stems.length) return { passages: [], partial: false, missing_terms: [] };
  const paras = paragraphs(md, opts.scope);
  const found = new Set<string>();
  const scored: { p: Paragraph; matched: string[]; hits: number }[] = [];
  for (const p of paras) {
    const counts = new Map<string, number>();
    for (const t of tokens(p.text)) { const s = stem(t); counts.set(s, (counts.get(s) ?? 0) + 1); }
    const matched = stems.filter((s) => counts.has(s));
    if (!matched.length) continue;
    matched.forEach((s) => found.add(s));
    scored.push({ p, matched, hits: matched.reduce((n, s) => n + counts.get(s)!, 0) });
  }
  const missing_terms = terms.filter((t) => !found.has(stem(t)));
  const full = scored.filter((x) => x.matched.length === stems.length);
  const partial = !full.length && scored.length > 0;
  // Partial matches: the rare term tells more than the common one ("lifespan"
  // twice in the paper outranks "mice" seventy times), so a passage's worth is
  // the sum of its matched terms' rarity.
  const df = new Map<string, number>();
  for (const x of scored) for (const s of x.matched) df.set(s, (df.get(s) ?? 0) + 1);
  const rarity = (x: { matched: string[] }) => x.matched.reduce((n, s) => n + 1 / df.get(s)!, 0);
  const pool = partial ? scored : full;
  const pick = pool
    .sort((a, b) => b.matched.length - a.matched.length || (partial ? rarity(b) - rarity(a) : 0) || b.hits - a.hits || a.p.text.length - b.p.text.length)
    .slice(0, maxHits);
  const passages = pick.map(({ p, matched }) => {
    const w = clip(p, matched, window);
    const out: Passage = { section: p.section, text: w.text };   // no hits count: the order already says best first
    if (partial) out.matched = terms.filter((t) => matched.includes(stem(t)));
    if (w.clipped) out.clipped = true;
    return out;
  });
  const r: SearchResult = { passages, partial, missing_terms };
  if (pool.length > passages.length) r.more = pool.length - passages.length;
  return r;
}

type Paragraph = { section: string; text: string; row?: string };  // row: a table row's header line, kept with the row

// Paragraphs of the text (inside `scope` when given): blank lines and
// headings separate them; a table row is a paragraph of its own, with the
// table's header row attached so the row reads with its column names.
function paragraphs(md: string, scope?: Section): Paragraph[] {
  const lines = md.split("\n");
  const secs = sections(md);
  const from = scope ? scope.start + 1 : 0, to = scope ? scope.end : lines.length;
  const sectionAt = (i: number) => { let h = ""; for (const s of secs) { if (s.start <= i) h = s.label; else break; } return h; };
  const out: Paragraph[] = [];
  let para: string[] = [], paraStart = 0, header: string | null = null;
  const flush = () => {
    const text = para.join("\n").trim(); para = [];
    if (text) out.push({ section: sectionAt(paraStart), text });
  };
  for (let i = from; i < to; i++) {
    const l = lines[i];
    if (!l.trim() || /^#{1,6}\s/.test(l)) { flush(); header = null; continue; }
    if (/^\|/.test(l)) {
      flush();
      if (/^\|?\s*:?-{3,}/.test(l)) continue;                 // the separator line
      if (header === null) { header = l.trim(); continue; }   // the header row: carried, not a passage
      out.push({ section: sectionAt(i), text: l.trim(), row: header });
      continue;
    }
    header = null;
    if (!para.length) paraStart = i;
    para.push(l);
  }
  flush();
  return out;
}

// The passage for a paragraph: whole when it fits the window; else the best
// sentence (most distinct terms) and its neighbours up to the window, with an
// ellipsis at each cut edge. A table row is cut hard at the window.
function clip(p: Paragraph, matched: string[], window: number): { text: string; clipped: boolean } {
  if (p.row !== undefined) {
    const text = `${p.row}\n${p.text}`;
    return text.length <= window ? { text, clipped: false } : { text: text.slice(0, window) + " …", clipped: true };
  }
  if (p.text.length <= window) return { text: p.text, clipped: false };
  const sents = p.text.split(/(?<=[.!?;])\s+(?=[^a-z])/u);
  const score = sents.map((s) => { const st = new Set(tokens(s).map(stem)); return matched.filter((m) => st.has(m)).length; });
  let best = 0;
  score.forEach((v, i) => { if (v > score[best]) best = i; });
  let lo = best, hi = best, len = sents[best].length;
  for (;;) {
    const left = lo > 0 ? sents[lo - 1].length + 1 : Infinity;
    const right = hi + 1 < sents.length ? sents[hi + 1].length + 1 : Infinity;
    if (Math.min(left, right) === Infinity || len + Math.min(left, right) > window) break;
    if (right <= left) { hi++; len += right; } else { lo--; len += left; }
  }
  let text = sents.slice(lo, hi + 1).join(" ");
  if (text.length > window) text = text.slice(0, window) + " …";
  if (lo > 0) text = "… " + text;
  if (hi + 1 < sents.length && !text.endsWith("…")) text += " …";
  return { text, clipped: true };
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[*_~^]/g, "").replace(/[-/]/g, " ");

export function tokens(s: string): string[] {
  return (fold(s).match(/[\p{L}\p{N}][\p{L}\p{N}'.%]*/gu) ?? []).map((t) => t.replace(/[.']+$/, "")).filter(Boolean);
}

// Plural, then -ation/-ing/-ed/-e, and -ies → y; words with a digit (HbA1c,
// M1, 95%) are left alone. Applied to query and text alike, so only equality
// after stemming matters, not that the stem is a word.
export function stem(w: string): string {
  if (/\d/.test(w)) return w;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.endsWith("ie")) return w.slice(0, -2) + "y";
  if (w.length >= 4) w = w.replace(/(ation|ing|ed|e)$/, "");
  return w;
}
