import { XMLParser } from "fast-xml-parser";
import { contactEmail } from "./contact.js";
import { fetchText } from "./http.js";
import { stripTags } from "./text.js";

// The `pubmed` tier: one efetch call for the PubMed record of a PMID, and the
// parser that pulls what the entry needs out of its XML. The XML itself is
// stored verbatim; nothing here rewrites text, it only extracts it.

export type PubmedRecord = {
  pmid: string;
  pmcid: string | null;
  doi: string | null;
  title: string;
  authors: string[];          // "Diaconu CC", collective names as written
  firstAuthor: string | null; // last name (or collective name) of the first author
  journal: string | null;
  year: string | null;
  publicationTypes: string[];
  abstract: { label: string | null; text: string }[];   // [] when PubMed has none
  corrections: Correction[];                             // notices about this paper, record order
  coi: string | null;         // <CoiStatement>: the conflict-of-interest statement as PubMed carries it (a quarter of records)
  funding: string[];          // <GrantList> agencies, unique, record order (a quarter of records)
};

// A notice about this paper from <CommentsCorrectionsList>: PubMed's RefType in
// snake case, the notice's PMID when the record has one, and <RefSource> (the
// notice's citation) verbatim. Only the "In" direction (a notice about this
// paper) is kept; "Of/For/From" (this paper being the notice), CommentIn
// (discussion, not a correction) and the rest are not corrections.
export type Correction = { type: CorrectionType; pmid: string | null; source: string };
export type CorrectionType = "erratum_in" | "retraction_in" | "partial_retraction_in" | "retracted_and_republished_in" | "expression_of_concern_in" | "update_in";

const CORRECTION_TYPES: Record<string, CorrectionType> = {
  ErratumIn: "erratum_in",
  RetractionIn: "retraction_in",
  PartialRetractionIn: "partial_retraction_in",
  RetractedandRepublishedIn: "retracted_and_republished_in",
  ExpressionOfConcernIn: "expression_of_concern_in",
  UpdateIn: "update_in",
};
const RETRACTION_TYPES = new Set<CorrectionType>(["retraction_in", "partial_retraction_in", "retracted_and_republished_in"]);

export const isRetractionNotice = (c: Correction) => RETRACTION_TYPES.has(c.type);

const EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

export function efetchUrl(pmid: string): string {
  const u = new URL(EFETCH);
  u.searchParams.set("db", "pubmed");
  u.searchParams.set("id", pmid);
  u.searchParams.set("retmode", "xml");
  if (process.env.FH_NCBI_API_KEY) u.searchParams.set("api_key", process.env.FH_NCBI_API_KEY);
  u.searchParams.set("tool", "evidence-mcp");
  u.searchParams.set("email", contactEmail());
  return u.toString();
}

export async function fetchPubmedXml(pmid: string): Promise<string> {
  try {
    return await fetchText(efetchUrl(pmid));
  } catch (e) {
    throw new Error(`pubmed fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- parsing ---------------------------------------------------------------

// ArticleTitle and AbstractText may carry inline markup (<i>, <sup>, …) and
// mixed content; as stop nodes they come back as their raw inner XML, which we
// flatten to text ourselves so the word order survives.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  processEntities: true,
  stopNodes: ["*.ArticleTitle", "*.AbstractText", "*.CoiStatement"],
  isArray: (name) => ["PubmedArticle", "PubmedBookArticle", "AbstractText", "Author", "ArticleId", "PublicationType", "CommentsCorrections", "Grant", "AuthorList"].includes(name),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

function text(n: Node): string {
  if (n == null) return "";
  if (typeof n === "object") return text(n["#text"]);
  return String(n);
}

// Plain-text nodes (names, journal, types): the parser leaves numeric character
// references ("Gali&#xe8;") as they are — decoded here. Not for the stop
// nodes, whose raw inner XML inlineText decodes once.
const plain = (n: Node) => decodeEntities(text(n)).trim();

function inlineText(raw: string): string {
  return decodeEntities(stripTags(raw)).replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Returns null when the response holds no <PubmedArticle> and no
// <PubmedBookArticle> (unknown PMID).
export function parsePubmedXml(xml: string): PubmedRecord | null {
  const doc = parser.parse(xml);
  const article: Node = doc?.PubmedArticleSet?.PubmedArticle?.[0];
  if (!article) {
    const book: Node = doc?.PubmedArticleSet?.PubmedBookArticle?.[0];
    return book ? parseBook(book) : null;
  }

  const cit = article.MedlineCitation ?? {};
  const art = cit.Article ?? {};

  const ids: Node[] = article.PubmedData?.ArticleIdList?.ArticleId ?? [];
  const idOf = (t: string) => {
    const hit = ids.find((i) => i["@_IdType"] === t);
    return hit ? text(hit).trim() || null : null;
  };

  const authorList: Node[] = art.AuthorList?.[0]?.Author ?? [];
  const authors = authorList
    .map((a: Node) => {
      if (a.CollectiveName) return plain(a.CollectiveName);
      const last = plain(a.LastName);
      const ini = plain(a.Initials);
      return [last, ini].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  const first = authorList[0];
  const firstAuthor = first ? plain(first.CollectiveName ?? first.LastName) || null : null;

  const pub = art.Journal?.JournalIssue?.PubDate ?? {};
  let year: string | null = text(pub.Year).trim() || null;
  if (!year) year = /\d{4}/.exec(text(pub.MedlineDate))?.[0] ?? null;

  const abstract = (art.Abstract?.AbstractText ?? []).map((a: Node) => ({
    label: typeof a === "object" ? (a["@_Label"] ?? null) : null,
    text: inlineText(text(a)),
  })).filter((a: { text: string }) => a.text);

  const corrections: Correction[] = (cit.CommentsCorrectionsList?.CommentsCorrections ?? []).flatMap((c: Node) => {
    const type = CORRECTION_TYPES[String(c["@_RefType"] ?? "")];
    if (!type) return [];
    return [{ type, pmid: text(c.PMID).trim() || null, source: inlineText(text(c.RefSource)) }];
  });

  const funding: string[] = [];
  for (const g of art.GrantList?.Grant ?? []) { const a = plain(g.Agency); if (a && !funding.includes(a)) funding.push(a); }

  return {
    coi: inlineText(text(cit.CoiStatement)) || null,
    funding,
    pmid: text(cit.PMID).trim() || idOf("pubmed") || "",
    pmcid: idOf("pmc"),
    doi: idOf("doi"),
    title: inlineText(text(art.ArticleTitle)),
    authors,
    firstAuthor,
    journal: plain(art.Journal?.Title) || null,
    year,
    publicationTypes: (art.PublicationTypeList?.PublicationType ?? []).map(plain).filter(Boolean),
    abstract,
    corrections,
  };
}

// A PubMed book record (<PubmedBookArticle>): a whole book or a chapter in
// NCBI Bookshelf — National Academies reports, NTP monographs, StatPearls.
// The chapter title when there is one, else the book title; the authors,
// else the editors; the publisher in place of the journal.
function parseBook(b: Node): PubmedRecord {
  const d = b.BookDocument ?? {};
  const book = d.Book ?? {};
  const ids: Node[] = [...(d.ArticleIdList?.ArticleId ?? []), ...(b.PubmedBookData?.ArticleIdList?.ArticleId ?? [])];
  const idOf = (t: string) => { const hit = ids.find((i) => i["@_IdType"] === t); return hit ? text(hit).trim() || null : null; };
  const lists: Node[] = [...(d.AuthorList ?? []), ...(book.AuthorList ?? [])];
  const pick = lists.find((l) => (l["@_Type"] ?? "authors") === "authors" && (l.Author ?? []).length) ?? lists.find((l) => (l.Author ?? []).length);
  const people: Node[] = pick?.Author ?? [];
  const authors = people.map((a: Node) => a.CollectiveName ? plain(a.CollectiveName) : [plain(a.LastName), plain(a.Initials)].filter(Boolean).join(" ")).filter(Boolean);
  const first = people[0];
  const abstract = (d.Abstract?.AbstractText ?? []).map((a: Node) => ({ label: typeof a === "object" ? (a["@_Label"] ?? null) : null, text: inlineText(text(a)) })).filter((a: { text: string }) => a.text);
  const types = ["Book", ...((d.PublicationType ?? []) as Node[]).map(plain).filter(Boolean)];
  return {
    pmid: text(d.PMID).trim() || idOf("pubmed") || "",
    pmcid: null,
    doi: idOf("doi") ?? (text(book.ELocationID).trim() || null),
    title: inlineText(text(d.ArticleTitle)) || inlineText(text(book.BookTitle)),
    authors, firstAuthor: first ? plain(first.CollectiveName ?? first.LastName) || null : null,
    journal: plain(book.Publisher?.PublisherName) || null,
    year: text(book.PubDate?.Year).trim() || null,
    publicationTypes: [...new Set(types)],
    abstract, corrections: [], coi: null, funding: [],
  };
}
