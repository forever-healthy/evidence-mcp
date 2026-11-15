// Who published a web page and when — what a model checking a search result
// needs to judge the source, and what a page states only in its <head>: the
// structured data (JSON-LD) first, then the meta tags. Everything else there is
// for search engines (breadcrumbs, search actions, keywords, images, logos,
// ratings) and is left out. Measured 2026-11-10 on 464 live pages: JSON-LD on
// 51% (median 1.8 k characters, mostly that SEO markup), an author on 28%, a
// published date on 25%, a modified date on 21%, "reviewed by" on 16 pages.
//
// The result is one line under the page's title:
//   Article · Healthline · by Jane Doe, RD · reviewed by John Smith, MD (2024-02-11) · published 2023-05-04 · updated 2024-02-11
// A field the page does not carry is left out; with none, no line.

export type PageMeta = { type: string | null; publisher: string | null; authors: string[]; reviewed_by: string[]; last_reviewed: string | null; published: string | null; modified: string | null };

// The types that describe what the page is; a generic WebPage says nothing and is not shown.
const CONTENT = /^(Article|NewsArticle|BlogPosting|ScholarlyArticle|MedicalScholarlyArticle|Report|MedicalWebPage|FAQPage|QAPage|Product|Drug|DietarySupplement|MedicalCondition|MedicalStudy|Dataset|Guideline|MedicalGuideline|HowTo|Recipe|PodcastEpisode|VideoObject|SearchResultsPage|CollectionPage|ProfilePage|WebPage)$/;
const RANK = (t: string) => t === "WebPage" ? 2 : /^(SearchResultsPage|CollectionPage|ProfilePage)$/.test(t) ? 1 : 0;

const text = (v: unknown): string => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
const names = (v: unknown): string[] => {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.map((x) => typeof x === "string" ? text(x) : text((x as { name?: unknown })?.name)).filter((s) => s && s.length <= 120);
};
// A date as YYYY-MM-DD, or YYYY-MM / YYYY when the page gives no more:
// "2024-02-11T10:00:00+01:00", "2010/08", "2025 Oct 29", "Nov 21, 2015",
// "Thu, 11/20/2025 - 08:15". Anything unreadable as it came, capped.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
export function normDate(raw: string): string {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?![\d])/.exec(s);
  if (m) return m[3] ? `${m[1]}-${pad(+m[2])}-${pad(+m[3])}` : `${m[1]}-${pad(+m[2])}`;
  m = /^(\d{4})(?:\s+([A-Za-z]{3})[a-z]*\.?(?:\s+(\d{1,2}))?)?$/.exec(s);   // PubMed style: "2025 Oct 29", "2011"
  if (m) { const mo = m[2] ? MONTHS.indexOf(m[2].toLowerCase()) + 1 : 0; return !m[2] ? m[1] : mo ? (m[3] ? `${m[1]}-${pad(mo)}-${pad(+m[3])}` : `${m[1]}-${pad(mo)}`) : s.slice(0, 30); }
  m = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s);   // "Nov 21, 2015"
  if (m && MONTHS.includes(m[1].toLowerCase())) return `${m[3]}-${pad(MONTHS.indexOf(m[1].toLowerCase()) + 1)}-${pad(+m[2])}`;
  m = /\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})\b/.exec(s);   // "21 November 2015"
  if (m && MONTHS.includes(m[2].toLowerCase())) return `${m[3]}-${pad(MONTHS.indexOf(m[2].toLowerCase()) + 1)}-${pad(+m[1])}`;
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s);   // US "11/20/2025"
  if (m && +m[1] <= 12) return `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  return s.slice(0, 30);
}
const day = (v: unknown): string | null => { const s = text(v); return s ? normDate(s) : null; };

function nodes(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (o: unknown) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    if (Array.isArray(r["@graph"])) walk(r["@graph"]);
    if (r["@type"]) out.push(r);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* a broken block says nothing */ }
  }
  return out;
}

function metaTags(html: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const head = html.slice(0, 300_000);
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (/\b(?:name|property|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "").toLowerCase();
    const val = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bcontent\s*=\s*'([^']*)'/i.exec(tag)?.[1];
    if (key && val && val.trim()) out.set(key, [...(out.get(key) ?? []), val.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()]);
  }
  return out;
}

export function pageMeta(html: string): PageMeta {
  const all = nodes(html);
  const typeOf = (n: Record<string, unknown>) => (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]).map(String).find((t) => CONTENT.test(t)) ?? null;
  const main = all.filter((n) => typeOf(n)).sort((a, b) => RANK(typeOf(a)!) - RANK(typeOf(b)!))[0];
  const site = all.find((n) => /^(Organization|NewsMediaOrganization|MedicalOrganization|WebSite)$/.test(String(n["@type"])));
  const tags = metaTags(html);
  const tag = (...keys: string[]) => { for (const k of keys) { const v = tags.get(k); if (v?.length) return v; } return [] as string[]; };
  const type = main ? typeOf(main) : null;
  const publisher = names(main?.publisher)[0] ?? tag("og:site_name", "citation_journal_title", "citation_publisher", "dc.publisher")[0] ?? names(site)[0] ?? null;
  // A person, not the publisher crediting itself ("ConsumerLab.com · by ConsumerLab.com").
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const people = (a: string[]) => [...new Set(a)].filter((x) => !/^https?:/i.test(x) && (!publisher || key(x) !== key(publisher)));
  const fromLd = people(main ? names(main.author) : []);
  return {
    type: type === "WebPage" ? null : type,
    publisher,
    authors: fromLd.length ? fromLd : people(tag("citation_author", "author", "article:author", "dc.creator")),
    reviewed_by: people(main ? names(main.reviewedBy) : []),
    last_reviewed: day(main?.lastReviewed),
    published: day(main?.datePublished) ?? day(tag("article:published_time", "citation_publication_date", "citation_date", "dc.date", "date", "pubdate")[0]),
    modified: day(main?.dateModified) ?? day(tag("article:modified_time", "og:updated_time", "last-modified")[0]),
  };
}

// "Last, First" names are joined with "; " so the list stays readable.
const list = (a: string[]) => { const sep = a.some((x) => x.includes(",")) ? "; " : ", "; return a.length > 3 ? `${a.slice(0, 3).join(sep)} et al.` : a.join(sep); };

// The line under the title, or "" when the page says none of it.
export function sourceLine(m: PageMeta): string {
  const parts = [
    m.type, m.publisher,
    m.authors.length ? `by ${list(m.authors)}` : null,
    m.reviewed_by.length ? `reviewed by ${list(m.reviewed_by)}${m.last_reviewed ? ` (${m.last_reviewed})` : ""}` : null,
    m.published ? `published ${m.published}` : null,
    m.modified && m.modified !== m.published ? `updated ${m.modified}` : null,
  ].filter((x): x is string => !!x);
  // A type or a publisher alone says too little to be worth a line.
  return parts.length >= 2 || parts.some((p) => /^(by|reviewed|published|updated) /.test(p)) ? parts.join(" · ") : "";
}

// The content with the source line under its first heading (the title).
export function withSourceLine(md: string, line: string): string {
  if (!line || md.startsWith("<error>")) return md;
  const m = /^(#[^\n]*\n)\n?/.exec(md);
  return m ? `${m[1]}\n${line}\n\n${md.slice(m[0].length)}` : `${line}\n\n${md}`;
}
