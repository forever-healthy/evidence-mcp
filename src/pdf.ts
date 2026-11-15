import { getDocumentProxy } from "unpdf";
import { emittedNames, glyphChar } from "./glyph-names.js";

// PDF → Markdown. Text extraction only (no layout analysis): paragraphs are
// kept, and lines that are a bare section name become headings so the
// methods/results check and fh_library_read can find them. Tables in PDFs do not
// survive as tables; the original PDF is kept beside the Markdown for that.

// Section names a bare line may stand for (canonical spelling; matched
// case-insensitively, "and"/"&" alike, with optional numbering).
const SECTION_NAMES = ["abstract", "summary", "background", "introduction", "method", "methods", "materials and methods", "material and methods",
  "methods and materials", "subjects and methods", "patients and methods", "participants and methods", "experimental", "experimental section",
  "experimental procedures", "study design", "study population", "participants", "procedure", "procedures", "statistical analysis",
  "result", "results", "results and discussion", "findings", "discussion", "conclusion", "conclusions", "limitations", "references",
  "acknowledgments", "acknowledgements", "funding", "conflict of interest", "conflicts of interest", "supplementary material", "supplementary information",
  // Cochrane reviews (their back-matter headings — Sources of support, Declarations of interest — have no text layer in the PDF)
  "objectives", "search methods", "selection criteria", "data collection and analysis", "main results", "authors' conclusions", "plain language summary",
  "summary of findings", "description of studies", "risk of bias in included studies", "effects of interventions", "summary of main results",
  "quality of the evidence", "implications for practice", "implications for research", "data and analyses"];
const squeeze = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/\u2019/g, "'").replace(/[^a-z']/g, "");
const BY_SQUEEZED = new Map(SECTION_NAMES.map((n) => [squeeze(n), n.replace(/\b\w/g, (c) => c.toUpperCase())]));

// The heading a bare line stands for, or null. Numbering ("2.1", "3 |") is
// dropped, so is a trailing colon and the line number an author manuscript
// carries at the end of every line ("Results254"). Some publishers set
// headings letter-spaced ("R E S U LT S"), which text extraction keeps as
// spaces: the comparison ignores spaces, so a short line is matched either way.
export function headingOf(line: string): string | null {
  let bare = line.trim().replace(/^\d+(\.\d+)*\.?\s*[|.]?\s*/, "").replace(/\s*:$/, "").replace(/([A-Za-z])\d{1,4}$/, "$1");
  if (bare.length > 60 || !/^[A-Za-z][A-Za-z &'\u2019]*$/.test(bare)) return null;
  return BY_SQUEEZED.get(squeeze(bare)) ?? null;
}

// `stats`, when given, receives the page count and the extracted text length:
// a scan has pages but next to no text (convertBytes reports "scanned pdf").
export async function pdfToMarkdown(bytes: Buffer, title: string, headLine: string, stats?: { pages?: number; chars?: number }): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { fontExtraProperties: true, verbosity: 0 });   // pdf.js errors only: its warnings ("getOperatorList - ignoring …") are noise on the server's stderr (#56)
  const text = await extractPages(pdf);
  if (stats) { stats.pages = pdf.numPages; stats.chars = text.replace(/\s+/g, " ").trim().length; }
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());
  const out: string[] = [`# ${title}`, "", headLine, ""];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push(para.join(" "), ""); para = []; } };
  for (const line of lines) {
    if (!line) { flush(); continue; }
    const h = headingOf(line);
    if (h) { flush(); out.push(`## ${h}`, ""); continue; }
    para.push(line);
  }
  flush();
  return fixGlyphs(out.join("\n")).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// The text of every page, assembled as unpdf's extractText does (an item's
// text, a newline where it ends a line, pages joined by a newline, runs of
// blanks collapsed) — but with the font of every item at hand: a glyph pdf.js
// could not map comes out as a control character, and the font's /Differences
// array still names it (C21, H11350), so the name is looked up in the glyph
// tables and the symbol restored. Fonts reach the main thread only once the
// page's operator list is built; getTextContent alone does not load them.
type TextItem = { str?: string; hasEOL?: boolean; fontName?: string; transform?: number[]; width?: number; height?: number };
type FontObj = { name?: string; differences?: Map<number, string> };
type Page = { getOperatorList(): Promise<unknown>; getTextContent(): Promise<{ items: unknown[] }>; commonObjs: { get(name: string): FontObj | undefined }; view?: number[] };
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/;

// One extracted line with its place on the page (geo false when the items
// carried no transform, as in tests): x0..x1 horizontal extent, y baseline,
// h the tallest item.
type Line = { text: string; x0: number; x1: number; y: number; h: number; geo: boolean };
const newLine = (): Line => ({ text: "", x0: Infinity, x1: -Infinity, y: 0, h: 0, geo: false });

export async function extractPages(pdf: { numPages: number; getPage(n: number): Promise<Page> }): Promise<string> {
  const pages: string[] = [];
  let prev: Line | null = null, closed = false;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const fonts = new Map<string, { name: string; emitted: Map<number, string> } | null>();
    const fontOf = (loaded: string) => {
      if (!fonts.has(loaded)) {
        let f: FontObj | undefined;
        try { f = page.commonObjs.get(loaded); } catch { f = undefined; }
        fonts.set(loaded, f?.differences instanceof Map ? { name: f.name ?? "", emitted: emittedNames(f.differences) } : null);
      }
      return fonts.get(loaded) ?? null;
    };
    let loaded = false;
    const lines: Line[] = [];
    let cur = newLine();
    closed = false;
    for (const it of (await page.getTextContent()).items as TextItem[]) {
      if (it.str == null) continue;
      let s = it.str;
      if (CONTROL.test(s) && it.fontName) {
        if (!loaded) { try { await page.getOperatorList(); } catch { /* fonts then stay unknown */ } loaded = true; }
        const font = fontOf(it.fontName);
        if (font) s = s.replace(new RegExp(CONTROL.source, "g"), (ch) => { const name = font.emitted.get(ch.charCodeAt(0)); return (name && glyphChar(font.name, name)) ?? ch; });
      }
      cur.text += s;
      if (it.transform && it.transform.length >= 6 && s.trim()) {
        const x = it.transform[4], w = it.width ?? 0;
        if (!cur.geo) { cur.y = it.transform[5]; cur.geo = true; }
        cur.x0 = Math.min(cur.x0, x); cur.x1 = Math.max(cur.x1, x + w); cur.h = Math.max(cur.h, it.height ?? 0);
      }
      // A hyphen that ends a line is marked; the paper decides later whether
      // it was a word break ("differ-\nence") or a compound ("time-\ndependent").
      // The hyphen is often an item of its own and the line end the next,
      // empty item ("signifi", "-", "" hasEOL), so the line's text so far is
      // what is looked at, not the item that carries hasEOL.
      if (it.hasEOL) {
        let t = cur.text, k = t.length;
        while (k > 0 && (t[k - 1] === " " || t[k - 1] === "\t")) k--;
        if (k >= 2 && t[k - 1] === "-" && /[A-Za-z]/.test(t[k - 2])) t = t.slice(0, k - 1) + BREAK + t.slice(k);
        cur.text = t;
        lines.push(cur); cur = newLine(); closed = true;
      } else closed = false;
    }
    if (cur.text) lines.push(cur);
    if (!lines.length) continue;
    pages.push((prev && breakBefore(prev, lines[0], columns(lines, page.view?.[2]), page.view?.[2]) ? "\n" : "") + joinLines(lines, prev, page.view?.[2]));
    prev = lines[lines.length - 1];
  }
  return dehyphenate((pages.join("\n") + (closed ? "\n" : "")).replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n"));
}

// Paragraphs from layout (#18). Text extraction gives lines, not paragraphs,
// and a journal PDF has no blank line between paragraphs — so a section used
// to come out as one paragraph (a Cochrane review: 400 KB in one). A new
// paragraph starts where the layout says so: extra leading before the line,
// a first-line indent, a list bullet, a change of type size, or the previous
// line ending short with a sentence and this one opening with a capital.
// Columns are told apart at half the page width; a line continuing in the
// next column or on the next page is joined unless one of those signs holds.
type Column = { left: number; right: number; pitch: number };

function columns(lines: Line[], pageWidth?: number): Column[] {
  const geo = lines.filter((l) => l.geo);
  const width = pageWidth ?? Math.max(0, ...geo.map((l) => l.x1));
  return [0, 1].map((c) => {
    const ls = geo.filter((l) => columnOf(l, width) === c);
    const dys: number[] = [];
    for (let i = 1; i < ls.length; i++) { const dy = ls[i - 1].y - ls[i].y; if (dy > 0 && dy < 3 * Math.max(ls[i].h, 6)) dys.push(dy); }
    return { left: percentile(ls.map((l) => l.x0), 0.05), right: rightEdge(ls.map((l) => l.x1)), pitch: percentile(dys, 0.5) };
  });
}
const columnOf = (l: Line, width: number) => (l.x0 < width / 2 ? 0 : 1);
function percentile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
// Justified text ends every full line at the same x: that mode is the edge.
// Ragged text has no mode; the 95th percentile stands in.
function rightEdge(x1s: number[]): number {
  if (!x1s.length) return 0;
  const bins = new Map<number, number>();
  for (const x of x1s) { const b = Math.round(x / 2); bins.set(b, (bins.get(b) ?? 0) + 1); }
  const [bin, n] = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
  return n >= 0.3 * x1s.length ? bin * 2 : percentile(x1s, 0.95);
}

function breakBefore(p: Line, l: Line, cols: Column[], pageWidth?: number): boolean {
  if (!p.geo || !l.geo) return false;
  const width = pageWidth ?? Math.max(p.x1, l.x1);
  const cp = cols[columnOf(p, width)], cl = cols[columnOf(l, width)];
  const text = l.text.trim(), ptext = p.text.trim();
  if (!text || !ptext) return false;
  if (/^[•▪◦●■□○·]|^[-–]\s/.test(text)) return true;                                   // a list item
  if (p.h && l.h && Math.abs(l.h - p.h) > 1.5) return true;                              // type size changes: a heading begins or ends
  const dy = p.y - l.y;
  if (cp === cl && dy > 0 && cl.pitch && dy > 1.4 * cl.pitch && dy < 6 * cl.pitch) return true;  // extra leading
  const indent = l.x0 - cl.left, pindent = p.x0 - cp.left;
  if (indent > 3 && indent < 40 && pindent <= 3) return true;                             // first-line indent (not a hanging indent's continuation)
  const short = p.x1 < cp.right - 0.08 * (cp.right - cp.left);
  return short && /[.!?:][)"'\]]?$/.test(ptext) && /^[A-Z0-9(["'•]/.test(text);           // a sentence ends a short line, a capital opens the next
}

function joinLines(lines: Line[], prev: Line | null, pageWidth?: number): string {
  const cols = columns(lines, pageWidth);
  let out = lines[0].text;
  for (let i = 1; i < lines.length; i++) out += (breakBefore(lines[i - 1], lines[i], cols, pageWidth) ? "\n\n" : "\n") + lines[i].text;
  void prev;
  return out;
}

// Line-break hyphens (#12). Typesetting breaks words at line ends ("differ-
// ence", about 125 per paper); extraction keeps the hyphen and the break, and
// phrase matches in fh_library_read and the claim model then miss the word. Only
// a hyphen at a real line end is a candidate (BREAK marks it; an inline
// "dose- and" is never one). The paper settles most: of 139,222 candidates in
// the library's PDFs (2026-11-06), 76% join to a word the same text uses
// elsewhere, 7% keep a hyphen the same text uses elsewhere ("time-dependent"),
// 1.4% are suspended hyphens before and/or/to. The rest: a compound prefix
// keeps its hyphen ("anti-inflammatory"), anything else joins — by sample,
// 7 in 10 of those are plain breaks ("perfor- mance"). A break before a
// capital or a digit keeps the hyphen without the line break ("non-Hodgkin").
const BREAK = "\u0000";
const SUSPENDED = new Set(["and", "or", "to", "vs", "but", "nor"]);
const COMPOUND_PREFIX = new Set(["anti", "non", "pre", "post", "self", "meta", "cross", "long", "short", "high", "low", "well", "placebo", "double", "single", "randomized", "randomised",
  "multi", "co", "inter", "intra", "sub", "semi", "dose", "time", "age", "sex", "over", "under", "half", "full", "all", "one", "two", "three", "first", "second", "third",
  "end", "mid", "late", "early", "whole", "small", "large", "vitamin", "omega", "alpha", "beta", "gamma", "type", "wild", "ex", "quasi", "pseudo", "peri", "re"]);
export function dehyphenate(text: string): string {
  if (!text.includes(BREAK)) return text;
  const lower = text.toLowerCase();
  const seen = (s: string) => new RegExp(`(?<![a-z])${s}(?![a-z])`).test(lower);
  return text.replace(/([A-Za-z]+)\u0000\n([A-Za-z]+)/g, (m, x: string, y: string) => {
    if (!/^[a-z]/.test(y)) return `${x}-${y}`;
    if (SUSPENDED.has(y.toLowerCase())) return `${x}- ${y}`;
    const hyph = `${x}-${y}`.toLowerCase(), joined = `${x}${y}`.toLowerCase();
    if (seen(hyph)) return `${x}-${y}`;
    if (seen(joined)) return `${x}${y}`;
    return COMPOUND_PREFIX.has(x.toLowerCase()) ? `${x}-${y}` : `${x}${y}`;
  }).replace(/\u0000\n/g, "-\n").replace(/\u0000/g, "-");
}

// Glyphs a publisher's font maps to the wrong code point, so text extraction
// gives another character (the fonts carry no ToUnicode and no glyph names to
// recover them from). Only substitutes seen standing for one symbol in every
// case are mapped, and only before a digit or decimal point:
//   ¡ → − in NEJM's fonts ("¡17.9", "¡7.6 to 1.6", "¡70°C") — 6 entries, all
//     NEJM PDFs; ¡ never precedes a digit in English text.
// Not mapped: À (once ≥ in "partial response as À30%", elsewhere a letter in
// Catalan names), and the control characters U+0001–U+0018 that symbol fonts
// such as MathematicalPi and Universal-GreekwithMathPi produce — the same code
// is minus in one font and ± or ≤ in another (design notes at the end of this file).
// U+0008 between two word characters is a font's space ("each\x08yearly\x08cohort").
export function fixGlyphs(md: string): string {
  return md.replace(/¡(?=\.?\d)/g, "\u2212").replace(/(?<=[\p{L}\p{N}])\u0008(?=[\p{L}\p{N}])/gu, " ");
}

// Control characters left in a text: symbols a font gave no Unicode for (a
// minus, ±, ≤ …). Counted, never guessed, so a verdict on such a text is not
// silent (status glyphs_unresolved, verify glyphs_unresolved).
export const UNRESOLVED_GLYPH = /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g;
export const countUnresolved = (text: string) => (text.match(UNRESOLVED_GLYPH) ?? []).length;

export const looksLikePdf = (bytes: Buffer) => bytes.subarray(0, 5).toString("latin1") === "%PDF-";

// ---- Design notes: PDF glyphs ----
//
// Some publisher fonts carry no usable ToUnicode map, so pdf.js emits a control
// character (U+0001–U+001F) for a symbol the page shows as −, ±, ≤ or β. Mapped
// since 2026-11-06 through the glyph's **name**: the font's `/Differences` array
// names every code (`[1 /C0 3 /C20 /C2 /C6 /C21]`, `[2 /H11349 /H11350 /H9262]`),
// and pdf.js hands it over as `commonObjs.get(fontName).differences` (a Map)
// when the document is opened with `fontExtraProperties: true` and the page's
// operator list has been built — `getTextContent` alone does not load the
// fonts. Found by AI4L (#11, 2026-11-06); the earlier "no glyph names" held
// for ToUnicode only.
//
// **Vocabularies** (src/glyph-names.ts). Adobe Pi names (`Hnnnnn` in
// MathematicalPi, Universal-GreekwithMathPi, Advent's AdvMathpi clones;
// `Lnnnnn` in EuropeanPi) and Monotype Greek names (`afii…`) mean the same
// glyph in every font → one global table (`PI_NAMES`, 55 entries). Advent's
// own `Cn` names are arbitrary per base font: AdvP4C4E59 holds accents at C19
// and C22 where AdvP4C4E74 holds symbols, so the per-family table
// (`FAMILY_NAMES`) lists AdvP4C4E74 (9 names) and C0/C2/C6 of AdvMT_SY and
// AdvMacMthSyN only. pdf.js's fallback for an unmapped glyph is its code —
// except a `Cnn`/`Cnnn` name (2–3 digits), whose number it takes as the code
// (C20 at code 3 → U+0014); `emittedNames` inverts that per font.
//
// **How each entry was checked** (scratch scripts, 2026-11-06, over the 275
// affected PDFs): (1) inventory with pdf.js — every (family, glyph name,
// emitted code) with its text contexts; (2) the glyph's outline from the
// embedded CFF (qpdf `--show-object --filtered-stream-data` on FontFile3,
// fontTools T2 charstrings), rasterised to 64×64 and classified by IoU against
// Liberation Serif/Sans references, up to six fonts per name; (3) accepted only
// when the shape's top-3 held the character for every sampled font and the
// contexts agreed (`H11350` "(BMI≥30)", `H9270` "AUCτ,ss", `H9260` "NF-κB",
// `C21` "(≥65 years)"). Dropped as unsettled: `H18528` (AI4L read `−` from a JCO
// context; the outline in all six fonts here is a bullet), `H11505`, `L1155`,
// `C14` (an empty circle: ° or ○), `H9018`'s neighbours. A chamfer distance on
// outline samples was tried first and confused ± with α and μ with ≠; IoU on
// filled bitmaps settled those.
//
// **Result.** 18,053 control characters in the 275 full texts scanned → 5,000
// after re-conversion from the stored PDFs (72 % resolved); over all 1,119 PDF
// texts, 5,790 remain in 162 entries. What stays, by cause: one PDF
// (pmid:20974732) with U+0008 as its word space at 3,180 places not between two
// word characters; a Type 3 font (glyphs as drawing procedures, no names:
// pmid:15647189, 708, a figure's text); AdvP4C4E59's
// accents (C19 acute, C22 macron: "Rosén", "Wabā'ī" — 450 uses; dropping them
// would make the names searchable, a separate change); two PDFs whose text
// fonts shift every code by 29 ("SRVVHVVHV" = "possesses"), garbled throughout,
// not a symbol problem; a tail of one-font names. Not touched, decided
// 2026-11-06: Elsevier's `AdvPS…` fonts (38 distinct in 111 PDFs, one to three
// glyphs each, named after the key they are typed with — `AdvPS3FDD77`'s
// charset is `['.notdef', 'Z']` and the outline is `=`), so `p Z 0.021`,
// `25e30 kg/m2`, `˃30 g/day` in pmid:37419751. Nothing in the file names the
// symbol; only the shape does, and the letter is uncountable. Measured: verify
// passes "p = 0.021" at 0.997 and "25 to 30 kg/m2" at 0.990 against that text.
// A (font, code) table with a counting fallback for the class, or a shape
// classifier in the server, would fix it; not worth it at this effect.
//
// **Guard.** test/fixtures/glyphs.pdf: one page with the two font subsets
// (programs only, 3 KB) — AdvP4C4E74 and MathematicalPi-One — and the test
// asserts "WMD: −1.54 mmHg; BMI ≥30; 48.5 ± 10; dose ≤1100 IU; 5 μg; 2 × 3"
// with `glyphs_unresolved` 0. A pdf.js update that changes any of the four
// internals makes it fail, where the library itself would only go back to
// counting. unpdf 1.9.1 pins the pdf.js build.
//
// Still in `fixGlyphs`: `¡` → `−` before a digit (NEJM's fonts), U+0008 between
// two word characters → space. Not mapped: `À` (once `≥`, elsewhere a Catalan
// letter).
//
// **Paragraphs from layout** (#18, 2026-11-07). pdf.js gives lines, and a
// journal PDF has no blank line between paragraphs, so a section came out as
// one paragraph — a Cochrane review as one 468 KB paragraph, which `query`
// then returned whole. `extractPages` keeps each line's place (x0, x1,
// baseline, type size) and `breakBefore` starts a paragraph on: extra leading
// (> 1.4 × the column's median pitch), a first-line indent (3–40 pt, after a
// flush line, so a hanging indent's continuation is not one), a list bullet, a
// change of type size (> 1.5 pt: a heading in or out), or the previous line
// ending short (> 8 % of the column width) with a sentence and this one
// opening with a capital. Columns are told apart at half the page width; a
// paragraph continues across a column or page unless one of those holds.
// Justified text's right edge is the mode of the lines' x1 (≥ 30 % of lines),
// ragged text's the 95th percentile. On the 2019 Annals meta-analysis (10
// pages) 274 paragraphs, median 76 chars (the small ones are table cells and
// footers); on the Cochrane review 6,345. Items without a transform (tests)
// never split. Independently, `search` in src/read.ts clips every passage to a
// window of WINDOW_CHARS around the matches, so an old one-paragraph text is
// read in pieces too.
//
// **Line-break hyphens** (#12, 2026-11-06). Typesetting breaks words at line
// ends ("differ- ence"); 139,222 such candidates in the 1,119 PDF texts, about
// 125 per paper, and a phrase match in `fh_library_read` or the claim model misses
// the word. `dehyphenate` (src/pdf.ts) decides only at a real line end — the
// item stream's `hasEOL`, marked with U+0000 before the lines are joined — so
// an inline "dose- and" is never touched. Order: a hyphenated form the same
// text uses elsewhere keeps it ("time-dependent", 7 %); a joined word the text
// uses elsewhere joins ("difference", 76 %); and/or/to/vs/but/nor after the
// hyphen is a suspended hyphen, kept with its space (1.4 %); a compound prefix
// (anti, non, pre, post, self, meta, long, placebo, …) keeps the hyphen; the
// rest joins — of the 16.5 % the paper cannot settle, 7 in 10 by sample are
// plain breaks ("perfor- mance"), the rest compounds the prefix list catches
// ("anti- inflammatory", "meta- analysis", "cross- sectional"). A break before
// a capital or digit keeps the hyphen without the line break ("non-Hodgkin").
// No dictionary: the paper is the dictionary. The mark is set from the line's
// text so far, not from the item that carries `hasEOL`: pdf.js often emits the
// hyphen as an item of its own and the line end as the next, empty item
// ("signifi", "-", "" hasEOL), and the first version (926f182) missed every one
// of those — AI4L measured 7,106 "word- word" patterns whose joined word the
// same text used elsewhere; after the fix (all 1,119 PDF texts re-converted)
// 85 remain, in lines pdf.js reports no line end for.
//
