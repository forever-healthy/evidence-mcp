// Content checks a full text must pass before it counts. They look at the converted Markdown, so one set serves every
// source format.

// Greek letters as PubMed spells them out ("alpha-linolenic", "TNF-alpha",
// "beta4"), so a title printed with α, β, γ in the paper still matches.
const GREEK: Record<string, string> = { "α": "alpha", "β": "beta", "ß": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ζ": "zeta", "η": "eta", "θ": "theta", "ι": "iota", "κ": "kappa", "λ": "lambda", "μ": "mu", "µ": "mu", "ν": "nu", "ξ": "xi", "π": "pi", "ρ": "rho", "σ": "sigma", "τ": "tau", "υ": "upsilon", "φ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega", "Α": "alpha", "Β": "beta", "Γ": "gamma", "Δ": "delta", "Ω": "omega", "Σ": "sigma", "Κ": "kappa", "Λ": "lambda", "Π": "pi", "Φ": "phi", "Ψ": "psi" };
const greek = (s: string) => s.replace(/[\u0370-\u03ff\u00b5\u00df]/g, (c) => GREEK[c] ?? c);
const norm = (s: string) => greek(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Compared with every non-alphanumeric removed as well: a subscript or
// superscript in the stored title ("C~12~FDG", "[D-Ala^2^]") is one word in
// PubMed's plain title ("C12FDG").
const compact = (s: string) => greek(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
export function hasTitle(md: string, title: string): boolean {
  const t = norm(title);
  if (!t) return true;
  if (norm(md).includes(t.slice(0, 60))) return true;
  return compact(md).includes(compact(title).slice(0, 50));
}

const WALL = [
  /checking your browser/i, /recaptcha/i, /verify (that )?you are (a )?human/i, /human verification/i, /access denied/i, /enable javascript/i, /javascript is (disabled|required)/i,
  /cloudflare/i, /captcha/i, /sign in to (continue|access)/i, /purchase (access|this article|pdf)/i,
  /subscribe to (read|access)/i, /cookie.{0,40}(consent|wall)/i, /403 forbidden/i, /page not found/i,
];

// True when the text is a bot wall, login, paywall or error page rather than
// an article. Short texts with wall phrases are the tell; a real paper that
// happens to mention "captcha" in its methods is long.
export function isWallPage(text: string): boolean {
  const short = text.length < 4000;
  if (short && WALL.some((re) => re.test(text))) return true;
  // A challenge page is longer than 4000 chars of script; its <title> tells.
  const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1] ?? "";
  return /checking your browser|recaptcha|just a moment|access denied|attention required|human verification/i.test(title);
}

const headings = (md: string) => md.split("\n").filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.replace(/^#+\s*/, ""));

// Methods and results present — or, for papers without those sections (reviews,
// case reports), a substantial sectioned body.
// Words of running prose: paragraphs of 40+ words that are not list items and
// not mostly links. A publisher's abstract page has 200–600 of them (the
// abstract, "related articles" blurbs); the shortest real articles 800+, the
// median paper 4000+. Measured on 672 stored PDF/HTML texts, 2026-10-28.
export function proseWords(md: string): number {
  let n = 0;
  for (const p of md.split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x && !/^#{1,6}\s/.test(x))) {
    const words = p.split(/\s+/).length;
    if (words < 40 || /^(-|\*|\d+\.)\s/.test(p)) continue;
    const linkChars = (p.match(/\[[^\]]*\]\([^)]*\)/g) ?? []).join("").length;
    if (linkChars / p.length > 0.3) continue;
    n += words;
  }
  return n;
}
export const MIN_PROSE = 800;

// Methods and results headings present (a structured abstract has them too —
// hence the prose floor in checkFulltext), or, for reviews and case reports, a
// sectioned body: 1200+ words under 2+ headings of which two are article sections.
export function hasMethodsAndResults(md: string): boolean {
  const hs = headings(md);
  const has = (re: RegExp) => hs.some((h) => re.test(h));
  if (has(/method|material|procedure|design|experimental|patients? and|participants/i) && has(/result|finding|outcome/i)) return true;
  const words = md.split(/\s+/).length;
  if (words < 1200 || hs.length < 2) return false;
  const SECTION = /^(abstract|summary|introduction|background|discussion|conclusions?|references|acknowledg|limitations|key points|funding|participants|statistical|supplementary|data availability|author contributions|competing interests|conflicts? of interest|disclosure)/i;
  return hs.filter((h) => SECTION.test(h.trim())).length >= 2;
}

export type Check = { ok: true } | { ok: false; reason: string };

// `titleSource`: where to look for the title when the converted text may have
// lost it — the raw HTML text of a publisher page (title in a <header> the
// converter drops). The body fallback still needs the title in `md` itself.
// The paper's DOI printed in the text identifies it as well as the title does
// (old PDFs set the title as a graphic; the DOI is in the footer).
export const hasDoi = (md: string, doi: string | null | undefined) => !!doi && compact(md).includes(compact(doi));

// Is this the paper (title in the text or its source, or the DOI in the text),
// and is it the article rather than a page about it?
// `trusted`: JATS XML from PMC/Europe PMC carries the body by construction and
// skips the prose floor (its paragraphs are what they are).
// `pdf`: a PDF cannot be a publisher's landing page — the page the structure
// test is there to refuse — so a PDF that is the paper (title or DOI at its
// start: a paper that only cites ours has the title in its references, at the
// end) and has the prose of an article is one, headings or not. Letters, case
// reports, old scans and non-English papers convert without the headings the
// structure test wants (found 2026-11-11: 7 such PDFs refused on live —
// letters, a case report, an ADA guideline chapter, three Russian articles).
export function checkFulltext(md: string, title: string, titleSource?: string, doi?: string | null, trusted = false, pdf = false): Check {
  if (isWallPage(md)) return { ok: false, reason: "wall page" };
  const inBody = hasTitle(md, title);
  if (!inBody && !(titleSource && hasTitle(titleSource, title)) && !hasDoi(md, doi)) return { ok: false, reason: "title missing" };
  if (!trusted && proseWords(md) < MIN_PROSE) return { ok: false, reason: "no methods/results" };
  if (pdf) {
    const head = md.slice(0, Math.max(6000, Math.floor(md.length / 4)));
    if (hasTitle(head, title) || hasDoi(head, doi)) return { ok: true };
  }
  if (!hasMethodsAndResults(md)) return { ok: false, reason: "no methods/results" };
  return { ok: true };
}
