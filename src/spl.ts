import { XMLParser } from "fast-xml-parser";
import { fetchText, LIBRARY_UA } from "./http.js";
import { cellPipes } from "./text.js";

// DailyMed drug labels (FDA Structured Product Labeling, HL7 v3) → Markdown.
// One label per set ID; the set ID is the fixed identifier of a product's
// label across its revisions, so the entry is always the current version
//. The web service gives the SPL as XML:
//   https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/<setid>.xml
// The product data (ingredients, packaging) is structured data, not text,
// and is left out; every text section is kept in document order.

export const DAILYMED_PAGE = (setid: string) => `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setid}`;
const SPL_URL = (setid: string) => `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${setid}.xml`;

export async function fetchSpl(setid: string): Promise<string> {
  // DailyMed answers 406 to a bare "Accept: application/xml"; "*/*" must be in the list.
  const xml = await fetchText(SPL_URL(setid), { "User-Agent": LIBRARY_UA, Accept: "application/xml, */*;q=0.8" });
  if (!/<document[\s>]/.test(xml.slice(0, 3000))) throw new Error("dailymed: not an SPL document");
  return xml;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, trimValues: false, processEntities: true, htmlEntities: true });
const tagOf = (n: N): string => Object.keys(n).find((k) => k !== ":@") ?? "";
const kids = (n: N): N[] => (n[tagOf(n)] as N[]) ?? [];
const attr = (n: N, a: string): string => n[":@"]?.[`@_${a}`] ?? "";
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const child = (n: N, tag: string): N | undefined => kids(n).find((x: N) => tagOf(x) === tag);
function findDeep(nodes: N[], tag: string): N | undefined {
  for (const n of nodes) { if ("#text" in n) continue; if (tagOf(n) === tag) return n; const h = findDeep(kids(n), tag); if (h) return h; }
  return undefined;
}

function inline(nodes: N[]): string {
  let out = "";
  for (const n of nodes) {
    if ("#text" in n) { out += String(n["#text"]); continue; }
    const t = tagOf(n); const inner = () => inline(kids(n));
    switch (t) {
      case "content": { const style = attr(n, "styleCode").toLowerCase(); const s = inner(); out += /bold/.test(style) ? `**${s}**` : /italic/.test(style) ? `*${s}*` : s; break; }
      case "sup": out += `^${inner()}^`; break;
      case "sub": out += `~${inner()}~`; break;
      case "br": out += " "; break;
      case "footnote": out += ` (${squash(inner())})`; break;
      case "footnoteRef": case "renderMultiMedia": break;
      default: out += inner();
    }
  }
  return out;
}

// Head rows first, body rows, and the footer (footnotes in SPL tables, which
// may precede the body in the XML) as lines after the table.
function table(n: N): string {
  const row = (x: N) => kids(x).filter((c: N) => ["td", "th"].includes(tagOf(c))).map((c: N) => cellPipes(squash(inline(kids(c)))));
  const collect = (nodes: N[], into: string[][]) => { for (const x of nodes) { if ("#text" in x) continue; if (tagOf(x) === "tr") into.push(row(x)); else if (!["thead", "tfoot"].includes(tagOf(x))) collect(kids(x), into); } };
  const head: string[][] = [], body: string[][] = [], foot: string[][] = [];
  for (const x of kids(n)) { const t = tagOf(x); if (t === "thead") collect(kids(x), head); else if (t === "tfoot") collect(kids(x), foot); else if (t === "tr") body.push(row(x)); else if (!("#text" in x) && t !== "caption") collect(kids(x), body); }
  const rows = [...head, ...body];
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
  const cap = child(n, "caption"); const title = cap ? squash(inline(kids(cap))) : "";
  const notes = foot.map((r) => r.filter(Boolean).join(" ")).filter(Boolean);
  return [title ? `**${title}**` : "", line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line), ...(notes.length ? ["", ...notes] : [])].filter((l, i) => l || i > 0).join("\n");
}

function blocks(nodes: N[], depth: number): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if ("#text" in n) { const t = squash(String(n["#text"])); if (t) out.push(t); continue; }
    const t = tagOf(n); const c = kids(n);
    switch (t) {
      case "paragraph": { const s = squash(inline(c.filter((x: N) => !["table", "list"].includes(tagOf(x))))); if (s) out.push(s); out.push(...blocks(c.filter((x: N) => ["table", "list"].includes(tagOf(x))), depth)); break; }
      case "list": { const ordered = /^(ordered|numbered|arabic|roman|alpha)/i.test(attr(n, "listType")); /* "unordered" is not ordered */ let i = 0; for (const it of c.filter((x: N) => tagOf(x) === "item")) { i++; const body = blocks(kids(it).filter((x: N) => tagOf(x) !== "caption"), depth).join(" "); if (body) out.push(`${ordered ? `${i}.` : "-"} ${body}`); } break; }
      case "table": { const md = table(n); if (md) out.push(md); break; }
      case "renderMultiMedia": case "observationMedia": case "subject": break;
      case "section": out.push(...section(n, depth)); break;
      case "component": case "text": case "excerpt": case "highlight": default: out.push(...blocks(c, depth)); break;
    }
  }
  return out;
}

// SPL PRODUCT DATA ELEMENTS (48780-1) and the package label sections hold
// structured product data and images; their text is nothing a review cites.
const SKIP_CODES = new Set(["48780-1", "51945-4"]);
// Header-level parts a review cites for safety statements: named even when
// the label gives them no title, and the boxed warning marked as such.
const CODE_NAMES: Record<string, string> = { "34066-1": "Boxed Warning", "43683-2": "Recent Major Changes" };
const plain = (nodes: N[]): string => { let out = ""; for (const n of nodes) out += "#text" in n ? String(n["#text"]) : tagOf(n) === "br" ? " " : plain(kids(n)); return out; };
function section(n: N, depth: number): string[] {
  const code = child(n, "code"); const c = code ? attr(code, "code") : "";
  if (SKIP_CODES.has(c)) return [];
  const title = child(n, "title");
  let head = title ? squash(plain(kids(title))) : "";          // plain: no **bold** inside a heading
  if (c === "34066-1" && head && !/boxed warning/i.test(head)) head = `Boxed Warning: ${head}`;
  if (!head && CODE_NAMES[c]) head = CODE_NAMES[c];
  const out: string[] = [];
  if (head) out.push(`${"#".repeat(Math.min(depth, 6))} ${head}`);
  const rest = kids(n).filter((x: N) => !["title", "code", "id", "effectiveTime"].includes(tagOf(x)));
  out.push(...blocks(rest, head ? depth + 1 : depth));
  return out;
}

export type SplDoc = {
  setid: string; version: string | null; effective: string | null; brand: string | null; generic: string | null; form: string | null; labeler: string | null; title: string;
  highlights: string[];          // the document title's lines other than the disclaimer: the product line, "Initial U.S. Approval: 2003"
  approvalYear: string | null;   // from "Initial U.S. Approval: <year>"
  sections: string[];
};

const isoDate = (v: string) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v || null);

export function parseSpl(xml: string): SplDoc | null {
  const doc = parser.parse(xml) as N[];
  const d = doc.find((x: N) => tagOf(x) === "document");
  if (!d) return null;
  const k = kids(d);
  const setid = attr(child(d, "setId") ?? {}, "root").toLowerCase();
  const version = attr(child(d, "versionNumber") ?? {}, "value") || null;
  const effective = isoDate(attr(child(d, "effectiveTime") ?? {}, "value"));
  // The first product that has a name: a repackager's label lists a nameless
  // <manufacturedMaterialKind> product first.
  const named = (nodes: N[]): N | undefined => { for (const n of nodes) { if ("#text" in n) continue; if (tagOf(n) === "manufacturedProduct") { const inner = child(n, "manufacturedProduct") ?? n; if (child(inner, "name")) return inner; } const h = named(kids(n)); if (h) return h; } return undefined; };
  const inner = named(k);
  const brand = inner ? squash(inline(kids(child(inner, "name") ?? { name: [] }))) || null : null;
  const genericNode = inner ? findDeep(kids(inner), "genericMedicine") : undefined;
  const generic = genericNode ? squash(inline(kids(child(genericNode, "name") ?? { name: [] }))) || null : null;
  const formNode = inner ? child(inner, "formCode") : undefined;
  const form = formNode ? attr(formNode, "displayName").toLowerCase() || null : null;
  const org = findDeep(k, "representedOrganization");
  const labeler = org ? squash(inline(kids(child(org, "name") ?? { name: [] }))) || null : null;
  const body = findDeep(k, "structuredBody");
  const sections = body ? blocks(kids(body), 2) : [];
  // The document title, the Highlights header: lines at <br/>, the disclaimer
  // dropped ("These highlights do not include … See full prescribing
  // information for X."), the product line and "Initial U.S. Approval: 2003" kept.
  const docTitle = child(d, "title");
  const lines: string[] = []; let cur = "";
  for (const x of docTitle ? kids(docTitle) : []) { if (!("#text" in x) && tagOf(x) === "br") { lines.push(cur); cur = ""; } else cur += "#text" in x ? String(x["#text"]) : inline([x]); }
  lines.push(cur);
  const highlights = lines.map(squash).filter((l) => l && !/^these highlights do not include/i.test(l) && !/^see full prescribing information/i.test(l))
    .map((l) => l.replace(/^see full prescribing information for [^.]+\.\s*/i, "")).filter(Boolean);
  const approvalYear = /initial u\.?s\.? approval:?\s*(\d{4})/i.exec(highlights.join(" "))?.[1] ?? null;
  const productLine = highlights.find((l) => !/initial u\.?s\.? approval/i.test(l)) ?? null;
  const title = [brand, generic ? `(${generic})` : "", form].filter(Boolean).join(" ") || productLine || setid;
  return { setid, version, effective, brand, generic, form, labeler, title: `${title} — prescribing information`, highlights, approvalYear, sections };
}

export function headLineSpl(s: SplDoc): string {
  return [s.labeler, `DailyMed set ID ${s.setid}`, s.version ? `version ${s.version}` : "", s.effective ? `effective ${s.effective}` : "", s.approvalYear ? `initial U.S. approval ${s.approvalYear}` : "", DAILYMED_PAGE(s.setid)].filter(Boolean).join(" · ");
}

export function renderLabelMd(s: SplDoc): string {
  const parts = [`# ${s.title}`, "", headLineSpl(s), ""];
  if (s.highlights.length) parts.push("## Highlights", "", ...s.highlights.flatMap((l) => [l, ""]));
  parts.push(...s.sections.flatMap((b) => [b, ""]));
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
