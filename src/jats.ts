import { XMLParser } from "fast-xml-parser";

// JATS (PMC full text XML) → Markdown. Order-preserving parse so that mixed
// content (text with <italic>, <xref>, … inside a paragraph) keeps its word
// order. Nothing is rewritten: text is extracted, inline markup mapped,
// structure (sections, lists, tables, figure captions, references) kept.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: true,
});

const tagOf = (n: N): string => Object.keys(n).find((k) => k !== ":@") ?? "";
const kids = (n: N): N[] => (n[tagOf(n)] as N[]) ?? [];
const attr = (n: N, a: string): string => n[":@"]?.[`@_${a}`] ?? "";

const SKIP_INLINE = new Set(["inline-graphic", "graphic", "private-char"]);

// A formula as text: the TeX source without its document wrapper when there
// is one (PMC wraps formulas in a full LaTeX document), else the MathML text.
function formula(n: N): string {
  const all = [n, ...descendants(n)];
  const tex = all.find((x) => tagOf(x) === "tex-math");
  if (tex) {
    let t = plainText(kids(tex)).trim();
    const m = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(t);
    if (m) t = m[1].trim();
    t = t.replace(/^\$+|\$+$/g, "").trim();
    return t ? `$${t}$` : "";
  }
  const mml = all.find((x) => /^(mml:)?math$/.test(tagOf(x)));
  return mml ? plainText(kids(mml)).replace(/\s+/g, "") : plainText(kids(n));
}

function descendants(n: N): N[] {
  if ("#text" in n) return [];
  const out: N[] = [];
  for (const k of kids(n)) { out.push(k, ...descendants(k)); }
  return out;
}

// "t<sub>max </sub>around" → "t~max~ around", not "t~max ~around": the
// blank leaves the markers, so the word stays one token for fh_library_read.
const wrap = (mark: string, s: string) => { const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!; return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : m[1] + m[3]; };

export function inlineText(nodes: N[]): string {
  let out = "";
  for (const n of nodes) {
    if ("#text" in n) { out += String(n["#text"]); continue; }
    const t = tagOf(n);
    if (SKIP_INLINE.has(t)) continue;
    const inner = () => inlineText(kids(n));
    switch (t) {
      case "italic": case "i": out += `*${inner()}*`; break;
      case "bold": case "b": out += `**${inner()}**`; break;
      case "sup": out += wrap("^", inner()); break;
      case "sub": out += wrap("~", inner()); break;
      case "break": out += " "; break;
      case "ext-link": case "uri": {
        const href = attr(n, "xlink:href") || attr(n, "href");
        const text = inner().trim() || href;
        out += href ? `[${text}](${href})` : text; break;
      }
      case "inline-formula": case "tex-math": case "mml:math": case "alternatives": out += formula(n); break;
      default: out += inner();
    }
  }
  return out;
}

function plainText(nodes: N[]): string {
  let out = "";
  for (const n of nodes) out += "#text" in n ? String(n["#text"]) : plainText(kids(n));
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const cell = (s: string) => squash(s).replace(/\|/g, "\\|");

function renderTable(table: N): string {
  const rows: string[][] = [];
  const walk = (nodes: N[]) => {
    for (const n of nodes) {
      const t = tagOf(n);
      if (t === "tr") rows.push(kids(n).filter((c: N) => ["td", "th"].includes(tagOf(c))).map((c: N) => cell(inlineText(kids(c)))));
      else if (!("#text" in n)) walk(kids(n));
    }
  };
  walk(kids(table));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  return [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

function labelCaption(n: N): string {
  const label = n ? squash(plainText(kids(n).filter((c: N) => tagOf(c) === "label"))) : "";
  const cap = kids(n).find((c: N) => tagOf(c) === "caption");
  const capText = cap ? squash(inlineText(kids(cap))) : "";
  return [label ? `**${label}.**` : "", capText].filter(Boolean).join(" ");
}

export function renderBlocks(nodes: N[], depth: number): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if ("#text" in n) { const t = squash(String(n["#text"])); if (t) out.push(t); continue; }
    const t = tagOf(n);
    const c = kids(n);
    switch (t) {
      case "sec": case "app": case "ack": case "boxed-text": case "notes": case "glossary": {
        const title = c.find((x: N) => tagOf(x) === "title");
        if (title) out.push(`${"#".repeat(Math.min(depth + 1, 6))} ${squash(inlineText(kids(title)))}`);
        else if (t === "ack") out.push(`${"#".repeat(Math.min(depth + 1, 6))} Acknowledgements`);
        out.push(...renderBlocks(c.filter((x: N) => tagOf(x) !== "title"), depth + 1));
        break;
      }
      case "title": out.push(`${"#".repeat(Math.min(depth + 1, 6))} ${squash(inlineText(c))}`); break;
      case "p": {
        const BLOCK = new Set(["table-wrap", "fig", "list", "disp-formula", "disp-quote", "boxed-text", "supplementary-material"]);
        const inline = c.filter((x: N) => "#text" in x || !BLOCK.has(tagOf(x)));
        const blocks = c.filter((x: N) => !("#text" in x) && BLOCK.has(tagOf(x)));
        const s = squash(inlineText(inline)); if (s) out.push(s);
        out.push(...renderBlocks(blocks, depth));
        break;
      }
      case "list": {
        const ordered = /order|alpha|roman|number/i.test(attr(n, "list-type"));
        let i = 0;
        for (const li of c.filter((x: N) => tagOf(x) === "list-item")) {
          i++;
          const body = renderBlocks(kids(li).filter((x: N) => tagOf(x) !== "label"), depth).join(" ");
          out.push(`${ordered ? `${i}.` : "-"} ${body}`);
        }
        break;
      }
      case "table-wrap": {
        const head = labelCaption(n);
        if (head) out.push(head);
        for (const tbl of c.filter((x: N) => tagOf(x) === "table")) { const md = renderTable(tbl); if (md) out.push(md); }
        const foot = c.find((x: N) => tagOf(x) === "table-wrap-foot");
        if (foot) out.push(...renderBlocks(kids(foot), depth));
        break;
      }
      case "fig": { const head = labelCaption(n); out.push(head || "*(figure)*"); break; }
      case "disp-formula": { const s = squash(formula(n)); if (s) out.push(s); break; }
      case "disp-quote": out.push(...renderBlocks(c, depth).map((l) => `> ${l}`)); break;
      case "def-list":
        for (const d of c.filter((x: N) => tagOf(x) === "def-item")) {
          const term = d["def-item"].find((x: N) => tagOf(x) === "term");
          const def = d["def-item"].find((x: N) => tagOf(x) === "def");
          out.push(`**${squash(inlineText(term ? kids(term) : []))}**: ${def ? renderBlocks(kids(def), depth).join(" ") : ""}`);
        }
        break;
      case "ref-list": {
        const title = c.find((x: N) => tagOf(x) === "title");
        out.push(`${"#".repeat(Math.min(depth + 1, 6))} ${title ? squash(inlineText(kids(title))) : "References"}`);
        for (const r of c.filter((x: N) => tagOf(x) === "ref")) {
          const rk = kids(r);
          const label = squash(plainText(rk.filter((x: N) => tagOf(x) === "label")));
          out.push(`- ${label ? `${label} ` : ""}${renderCitation(rk.filter((x: N) => tagOf(x) !== "label"))}`);
        }
        break;
      }
      case "supplementary-material": case "graphic": case "media": case "fn-group": case "label": break;
      default: out.push(...renderBlocks(c, depth));
    }
  }
  return out;
}

// A reference: <mixed-citation> is prose and read as is; <element-citation>
// is fielded and joined in the usual order. <citation-alternatives> picks the
// prose form when both exist.
function renderCitation(nodes: N[]): string {
  const alt = nodes.find((x: N) => tagOf(x) === "citation-alternatives");
  if (alt) return renderCitation(kids(alt));
  const mixed = nodes.find((x: N) => ["mixed-citation", "citation", "nlm-citation"].includes(tagOf(x)) && !kids(x).some((y: N) => tagOf(y) === "person-group"));
  if (mixed) return squash(inlineText(kids(mixed)));
  const el = nodes.find((x: N) => ["element-citation", "mixed-citation", "citation", "nlm-citation"].includes(tagOf(x)));
  if (!el) return squash(inlineText(nodes));
  const f = kids(el);
  const get = (tag: string) => f.filter((x: N) => tagOf(x) === tag).map((x: N) => squash(inlineText(kids(x))));
  const names = f.filter((x: N) => tagOf(x) === "person-group").flatMap((g: N) => kids(g)).map((x: N) => {
    const t = tagOf(x);
    if (t === "etal") return "et al";
    if (t === "collab") return squash(plainText(kids(x)));
    if (t === "name" || t === "string-name") {
      const sur = squash(plainText(kids(x).filter((y: N) => tagOf(y) === "surname")));
      const giv = squash(plainText(kids(x).filter((y: N) => tagOf(y) === "given-names")));
      return [sur, giv].filter(Boolean).join(" ");
    }
    return "";
  }).filter(Boolean);
  const vol = get("volume")[0], issue = get("issue")[0], fp = get("fpage")[0], lp = get("lpage")[0];
  const pages = fp ? (lp ? `${fp}-${lp}` : fp) : get("elocation-id")[0];
  const where = [get("source")[0], get("year")[0] ? `${get("year")[0]};` : "", vol ? `${vol}${issue ? `(${issue})` : ""}` : "", pages ? `:${pages}` : ""].filter(Boolean).join("").replace(/;$/, "");
  const ids = f.filter((x: N) => tagOf(x) === "pub-id").map((x: N) => `${attr(x, "pub-id-type")}:${squash(plainText(kids(x)))}`);
  return [names.join(", "), [...get("article-title"), ...get("chapter-title")][0], where, ...ids].filter(Boolean).join(". ").replace(/\.\./g, ".");
}

export type JatsDoc = { title: string; abstract: string[]; body: string[]; declarations: string[]; back: string[]; hasBody: boolean };

// Declarations: funding, conflicts of interest and the other notes, from
// wherever JATS puts them — <funding-group> in the article metadata,
// <author-notes> footnotes other than the corresponding author, <fn-group> in
// the back matter (dropped before 2026-11-05: a third of the PMC full texts
// had their conflict statement in the XML and not in the Markdown). One fixed
// heading, so fh_library_read(section "Declarations") is one call that always
// works, and a reader can tell "declares no conflict" from "says nothing".
const FN_LABELS: Record<string, string> = {
  "conflict": "Conflicts of interest", "COI-statement": "Conflicts of interest", "coi-statement": "Conflicts of interest",
  "financial-disclosure": "Financial disclosure", "supported-by": "Funding", "funding": "Funding",
  "equal": "Author note", "con": "Contributions", "contributed-by": "Contributions", "other": "",
};
function declarations(meta: N | undefined, back: N | undefined): string[] {
  const out: string[] = [];
  const fg = meta ? findDeep(kids(meta), "funding-group") : undefined;
  if (fg) {
    const statements = kids(fg).filter((x: N) => tagOf(x) === "funding-statement").map((x: N) => squash(inlineText(kids(x)))).filter(Boolean);
    const awards = kids(fg).filter((x: N) => tagOf(x) === "award-group").map((ag: N) => {
      const src = kids(ag).filter((x: N) => tagOf(x) === "funding-source").map((x: N) => squash(plainText(kids(x)))).filter(Boolean);
      const ids = kids(ag).filter((x: N) => tagOf(x) === "award-id").map((x: N) => squash(plainText(kids(x)))).filter(Boolean);
      return [src.join(", "), ids.length ? `(${ids.join(", ")})` : ""].filter(Boolean).join(" ");
    }).filter(Boolean);
    const text = statements.length ? statements.join(" ") : awards.join("; ");
    if (text) out.push(`Funding: ${text}`);
  }
  const fns: N[] = [];
  const notes = meta ? findDeep(kids(meta), "author-notes") : undefined;
  if (notes) fns.push(...kids(notes).filter((x: N) => tagOf(x) === "fn"));
  if (back) for (const g of kids(back).filter((x: N) => tagOf(x) === "fn-group")) fns.push(...kids(g).filter((x: N) => tagOf(x) === "fn"));
  for (const fn of fns) {
    const text = renderBlocks(kids(fn).filter((x: N) => tagOf(x) !== "label"), 1).join(" ").trim();
    if (!text) continue;
    const label = FN_LABELS[attr(fn, "fn-type")] ?? "";
    out.push(label && !new RegExp(`^[*_]*${label.split(" ")[0]}`, "i").test(text) ? `${label}: ${text}` : text);
  }
  return out;
}

// <sec-group> (Elsevier mapping) is a transparent wrapper: handled as blocks.

function find(nodes: N[], path: string[]): N | undefined {
  let cur: N[] = nodes;
  let hit: N | undefined;
  for (const tag of path) {
    hit = cur.find((x: N) => tagOf(x) === tag);
    if (!hit) return undefined;
    cur = kids(hit);
  }
  return hit;
}

function findDeep(nodes: N[], tag: string): N | undefined {
  for (const n of nodes) {
    if ("#text" in n) continue;
    if (tagOf(n) === tag) return n;
    const hit = findDeep(kids(n), tag);
    if (hit) return hit;
  }
  return undefined;
}

// Parses the efetch(db=pmc) XML of one article. hasBody is false when the
// publisher withholds the full text (no <body>), which is the pmc tier's
// "no body" failure.
export function parseJats(xml: string): JatsDoc {
  const doc = parser.parse(xml) as N[];
  const article = find(doc, ["pmc-articleset", "article"]) ?? find(doc, ["article"]) ?? findDeep(doc, "article");
  const a = article ? kids(article) : [];
  const front = find(a, ["front"]);
  const meta = front ? (find(kids(front), ["article-meta"]) ?? front) : undefined;
  const titleNode = meta ? (find(kids(meta), ["title-group", "article-title"]) ?? findDeep(kids(meta), "article-title")) : undefined;
  const abstractNode = meta ? kids(meta).find((x: N) => tagOf(x) === "abstract" && !attr(x, "abstract-type")) ?? findDeep(kids(meta), "abstract") : undefined;
  const body = find(a, ["body"]);
  const back = find(a, ["back"]);
  return {
    title: titleNode ? squash(inlineText(kids(titleNode))) : "",
    abstract: abstractNode ? renderBlocks(kids(abstractNode).filter((x: N) => tagOf(x) !== "title"), 2) : [],
    body: body ? renderBlocks(kids(body), 1) : [],
    declarations: declarations(meta, back),
    back: back ? renderBlocks(kids(back), 1) : [],
    hasBody: !!body && kids(body).length > 0,
  };
}

// The full-text Markdown: same head as the abstract file, then the article.
export function renderFulltextMd(doc: JatsDoc, headLine: string): string {
  const parts = [`# ${doc.title}`, "", headLine, ""];
  if (doc.abstract.length) parts.push("## Abstract", "", ...doc.abstract.flatMap((b) => [b, ""]));
  parts.push(...doc.body.flatMap((b) => [b, ""]));
  if (doc.declarations.length) parts.push("## Declarations", "", ...doc.declarations.flatMap((b) => [b, ""]));
  parts.push(...doc.back.flatMap((b) => [b, ""]));
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
