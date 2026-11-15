import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Where the library lives: FH_EVIDENCE_DIR, else /evidence when it exists (the
// Docker volume), else ./evidence relative to the cwd. Resolved once at start.
export const FH_EVIDENCE_DIR: string = (() => {
  const env = process.env.FH_EVIDENCE_DIR;
  if (env && env.trim()) return resolve(env.trim());
  if (existsSync("/evidence")) return "/evidence";
  return resolve("evidence");
})();

// Layout: <type>/<L1>/<L2>/<number>/ — L1 is the number without its last six
// digits, L2 without its last four (entryDirRel below). Short numbers fall
// back to "0" so every entry sits at the same depth.
// A DOI as a file and directory name: lowercase, every run of characters other
// than a–z, 0–9, "." and "-" as one "_" (10.5812/asjsm.110753 → 10.5812_asjsm.110753).
export const doiSlug = (doi: string) => doi.toLowerCase().replace(/[^a-z0-9.-]+/g, "_");

export function entryDirRel(type: string, num: string): string {
  // A DOI slug: its SHA-1's first 2 and 4 hex digits, so DOIs of one publisher
  // prefix (10.1016/…) spread over the directories.
  if (type === "doi") { const h = createHash("sha1").update(num).digest("hex"); return `${type}/${h.slice(0, 2)}/${h.slice(0, 4)}/${num}`; }
  if (!/^\d+$/.test(num)) return `${type}/${num.slice(0, 2)}/${num.slice(0, 4)}/${num}`;   // a set ID: its first 2 and 4 characters
  const l1 = num.length > 6 ? num.slice(0, -6) : "0";
  const l2 = num.length > 4 ? num.slice(0, -4) : "0";
  return `${type}/${l1}/${l2}/${num}`;
}

export type EntryPaths = {
  entry: string;      // pmid-30955454
  entryDir: string;   // absolute
  xml: string;        // …/pmid-30955454-abstract.xml
  md: string;         // …/pmid-30955454-abstract.md
  meta: string;       // …/pmid-30955454-meta.md
  fulltextMd: string; // …/pmid-30955454-fulltext.md
  fulltextRaw: (format: string) => string; // …/pmid-30955454-fulltext.<xml|html|pdf>
};

export function entryPaths(libraryDir: string, type: string, num: string): EntryPaths {
  if (type === "doi") num = doiSlug(num);
  const entry = `${type}-${num}`;
  const entryDir = join(libraryDir, entryDirRel(type, num));
  return {
    entry,
    entryDir,
    xml: join(entryDir, `${entry}-abstract.xml`),
    md: join(entryDir, `${entry}-abstract.md`),
    meta: join(entryDir, `${entry}-meta.md`),
    fulltextMd: join(entryDir, `${entry}-fulltext.md`),
    fulltextRaw: (format: string) => join(entryDir, `${entry}-fulltext.${format}`),
  };
}
