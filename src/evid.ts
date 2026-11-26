import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./entry.js";
import { num } from "./env.js";
import { outline, readSection, findSections, search, stem, tokens, type SearchResult } from "./read.js";

// EVID (#77, development only: FH_EVID_ENABLED) — a persistent, session-independent
// object store (README-evid.md; inside: stuff/evid/architecture.md). An EVID names a directory in the library,
// evid/<h0-2>/<h0-4>/<hash>/, holding metadata.json (immutable, any JSON fields plus
// "created") and objects (.json, .csv, .txt, .md). The EVID is "evid:" + the first 16
// hex digits of SHA-256 over metadata.json in canonical form (keys sorted, no
// whitespace); every call recomputes it, so a hand-edited or damaged metadata.json
// is refused. Nothing is ever deleted; a put keeps the replaced object as its
// previous version (one), in previous/.

export const evidEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(true|1|yes|on)$/i.test(env.FH_EVID_ENABLED?.trim() ?? "");
export const maxBytes = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVID_MAX_MB", 10, env, (n) => n > 0) * 1024 * 1024;

export const TYPES = ["json", "csv", "txt", "md"] as const;
export const MAX_NAME = 64;
const NAME = /^[a-z0-9_-]+\.(json|csv|txt|md)$/;
const METADATA = "metadata.json";
const PREVIOUS = "previous";
export const DEFAULT_MAX_CHARS = 20000;

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

// JSON with every object's keys sorted and no whitespace: the form the hash is taken over.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export const hashOf = (metadata: Record<string, unknown>): string => createHash("sha256").update(canonical(metadata)).digest("hex").slice(0, 16);
export const evidDir = (lib: string, hash: string): string => join(lib, "evid", hash.slice(0, 2), hash.slice(0, 4), hash);

// "evid:0123456789abcdef" or the bare 16 hex digits.
export function parseEvid(evid: string): string | null {
  const m = /^(?:evid:)?([0-9a-f]{16})$/i.exec(evid.trim());
  return m ? m[1].toLowerCase() : null;
}

// ---- names and content -----------------------------------------------------

// An invalid name is an error with the valid form, never normalized silently:
// two names could become one, and the caller would not know the stored name.
export function checkName(name: string): string | null {
  if (name === METADATA) return `${METADATA} is the EVID's metadata, written once at create; it cannot be put`;
  if (name.length <= MAX_NAME && NAME.test(name)) return null;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const base = (dot > 0 ? name.slice(0, dot) : name).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "object";
  if (!(TYPES as readonly string[]).includes(ext)) return `invalid name '${name}': the extension sets the type; allowed: ${TYPES.map((t) => "." + t).join(", ")}`;
  const valid = `${base.slice(0, MAX_NAME - ext.length - 1)}.${ext}`;
  return `invalid name '${name}'; use '${valid}' (lowercase letters, digits, _ and -, then the extension; at most ${MAX_NAME} characters; no folders)`;
}

// RFC 4180: comma-separated, fields in double quotes may hold commas, quotes ("")
// and line breaks. Every row has the header's number of fields.
export function parseCsv(text: string): { ok: true; rows: string[][] } | Fail {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, i = 0, line = 1;
  const endRow = () => { row.push(field); field = ""; rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      if (c === "\n") line++;
      field += c; i++; continue;
    }
    if (c === '"') {
      if (field !== "") return fail(`csv: line ${line}: a quote inside an unquoted field`);
      quoted = true; i++; continue;
    }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r" && text[i + 1] === "\n") { i++; continue; }
    if (c === "\n") { endRow(); line++; i++; continue; }
    field += c; i++;
  }
  if (quoted) return fail("csv: a quoted field is not closed");
  if (field !== "" || row.length) endRow();
  if (!rows.length) return fail("csv: empty; at least a header row");
  const width = rows[0].length;
  for (let r = 1; r < rows.length; r++) if (rows[r].length !== width) return fail(`csv: row ${r + 1} has ${rows[r].length} fields, the header ${width}`);
  return { ok: true, rows };
}

export function checkContent(type: string, content: string): string | null {
  if (content.includes("\u0000")) return `${type}: holds a NUL character; text only`;
  if (type === "json") { try { JSON.parse(content); return null; } catch (e) { return `json: does not parse: ${e instanceof Error ? e.message : String(e)}`; } }
  if (type === "csv") { const r = parseCsv(content); return r.ok ? null : r.error; }
  return null;
}

const typeOf = (name: string) => name.slice(name.lastIndexOf(".") + 1);

// ---- the store -----------------------------------------------------------------

export type Metadata = Record<string, unknown> & { created: string };
type Open = { ok: true; evid: string; dir: string; metadata: Metadata };

export function createEvid(lib: string, fields: unknown, now: Date = new Date()): { ok: true; evid: string; metadata: Metadata } | Fail {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return fail("metadata: an object of fields, e.g. { \"topic\": \"…\" }");
  if ("created" in fields) return fail("metadata: created is added by the server; leave it out");
  const metadata = { ...(fields as Record<string, unknown>), created: now.toISOString() } as Metadata;
  const hash = hashOf(metadata);
  const dir = evidDir(lib, hash);
  if (existsSync(join(dir, METADATA))) return fail(`evid:${hash} exists already; create again`);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, METADATA), JSON.stringify(metadata, null, 2) + "\n");
  return { ok: true, evid: `evid:${hash}`, metadata };
}

// Every call that names an EVID: the directory exists and metadata.json still hashes to it.
export function openEvid(lib: string, evid: string): Open | Fail {
  const hash = parseEvid(evid);
  if (!hash) return fail(`invalid evid '${evid}': "evid:" and 16 hex digits`);
  const dir = evidDir(lib, hash);
  const file = join(dir, METADATA);
  if (!existsSync(file)) return fail(`evid:${hash} not found`);
  let metadata: Metadata;
  try { metadata = JSON.parse(readFileSync(file, "utf8")); } catch { return fail(`evid:${hash}: metadata.json does not parse; nothing read or written`); }
  if (hashOf(metadata) !== hash) return fail(`evid:${hash}: metadata.json does not match its EVID (edited or damaged); nothing read or written`);
  return { ok: true, evid: `evid:${hash}`, dir, metadata };
}

export type ObjectInfo = { name: string; type: string; size: number; written: string; previous?: true };

export function listObjects(lib: string, evid: string): { ok: true; evid: string; metadata: Metadata; objects: ObjectInfo[] } | Fail {
  const o = openEvid(lib, evid);
  if (!o.ok) return o;
  const objects: ObjectInfo[] = [];
  for (const name of readdirSync(o.dir).sort()) {
    if (name === METADATA || !NAME.test(name)) continue;   // previous/, temp files
    const st = statSync(join(o.dir, name));
    if (!st.isFile()) continue;
    const info: ObjectInfo = { name, type: typeOf(name), size: st.size, written: st.mtime.toISOString() };
    if (existsSync(join(o.dir, PREVIOUS, name))) info.previous = true;
    objects.push(info);
  }
  return { ok: true, evid: o.evid, metadata: o.metadata, objects };
}

export function putObject(lib: string, evid: string, name: string, content: string, env: NodeJS.ProcessEnv = process.env): { ok: true; replaced: boolean; size: number } | Fail {
  const bad = checkName(name);
  if (bad) return fail(bad);
  const size = Buffer.byteLength(content, "utf8");
  const max = maxBytes(env);
  if (size > max) return fail(`${name}: ${size} bytes, above the limit of ${max} (FH_EVID_MAX_MB)`);
  const problem = checkContent(typeOf(name), content);
  if (problem) return fail(`${name}: ${problem}`);
  const o = openEvid(lib, evid);
  if (!o.ok) return o;
  const file = join(o.dir, name);
  const replaced = existsSync(file);
  if (replaced) { mkdirSync(join(o.dir, PREVIOUS), { recursive: true }); renameSync(file, join(o.dir, PREVIOUS, name)); }
  writeAtomic(file, content);
  return { ok: true, replaced, size };
}

// The EVIDs whose metadata has every given field. A text value matches when the stored text holds
// every word of it, case ignored ("telmisartan" finds "Telmisartan for Health & Longevity"): the
// answer is a list with each EVID's metadata, so the caller sees what matched. Any other value
// (a number, true/false, a list, an object) must be equal. EVIDs where every field is equal come
// first; newest first within each group.
export function findEvids(lib: string, query: Record<string, unknown>, max = 20): { ok: true; total: number; evids: { evid: string; metadata: Metadata }[] } | Fail {
  if (!query || typeof query !== "object" || Array.isArray(query)) return fail("query: an object of fields, e.g. { \"topic\": \"…\" }");
  const want = Object.entries(query);
  const words = (t: string) => t.toLowerCase().split(/\s+/).filter(Boolean);
  // 2: equal; 1: a text that holds the words; 0: no match
  const match = (have: unknown, v: unknown): number => {
    if (canonical(have) === canonical(v)) return 2;
    if (typeof have !== "string" || typeof v !== "string") return 0;
    const h = have.toLowerCase(), w = words(v);
    if (h.trim() === v.toLowerCase().trim() && w.length) return 2;   // the same text but for case
    return w.length && w.every((x) => h.includes(x)) ? 1 : 0;
  };
  const hits: { evid: string; metadata: Metadata; exact: boolean }[] = [];
  const root = join(lib, "evid");
  const dirs = (p: string) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(p, d.name)); } catch { return []; } };
  for (const l1 of dirs(root)) for (const l2 of dirs(l1)) for (const dir of dirs(l2)) {
    const hash = dir.slice(dir.lastIndexOf("/") + 1);
    let metadata: Metadata;
    try { metadata = JSON.parse(readFileSync(join(dir, METADATA), "utf8")); } catch { continue; }
    if (hashOf(metadata) !== hash) continue;   // damaged: refused by every call naming it, so not offered
    const m = want.map(([k, v]) => (k in metadata ? match(metadata[k], v) : 0));
    if (m.every((x) => x > 0)) hits.push({ evid: `evid:${hash}`, metadata, exact: m.every((x) => x === 2) });
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || String(b.metadata.created).localeCompare(String(a.metadata.created)));
  return { ok: true, total: hits.length, evids: hits.slice(0, max).map(({ evid, metadata }) => ({ evid, metadata })) };
}

// ---- get ---------------------------------------------------------------------

export type GetOptions = { section?: string; query?: string; max_chars?: number; max_hits?: number; previous?: boolean; lines?: string };

export function getObject(lib: string, evid: string, name: string, opts: GetOptions = {}, env: NodeJS.ProcessEnv = process.env): ({ ok: true } & Record<string, unknown>) | Fail {
  const bad = name === METADATA ? null : checkName(name);
  if (bad) return fail(bad);
  const o = openEvid(lib, evid);
  if (!o.ok) return o;
  if (name === METADATA) return { ok: true, content: JSON.stringify(o.metadata, null, 2) };
  const file = opts.previous ? join(o.dir, PREVIOUS, name) : join(o.dir, name);
  if (!existsSync(file)) return fail(opts.previous ? `${name}: no previous version` : `${name}: no such object (fh_evid_list_objects lists them)`);
  const size = statSync(file).size;
  if (size > maxBytes(env)) return fail(`${name}: ${size} bytes, above the limit of ${maxBytes(env)} (FH_EVID_MAX_MB); not opened`);
  const text = readFileSync(file, "utf8");
  const type = typeOf(name);
  const maxChars = opts.max_chars ?? DEFAULT_MAX_CHARS;

  if (opts.lines !== undefined) {
    if (opts.section !== undefined || opts.query !== undefined) return fail("lines: alone, not with section or query");
    if (type === "json") return fail("lines: .md, .txt and .csv objects; a .json object is read whole");
    return byLines(type, text, opts.lines, maxChars);
  }

  if (opts.section !== undefined) {
    if (type !== "md") return fail(`section: .md objects only; ${name} is .${type}`);
    if (opts.query === undefined) {
      const s = readSection(text, opts.section, maxChars);
      if (!s) return fail(`section '${opts.section}' not found; headings: ${outline(text, "full_text").sections.map((x) => x.heading).join(" | ")}`);
      return { ok: true, ...s };
    }
  }
  if (opts.query !== undefined) {
    if (type === "csv") return { ok: true, ...csvQuery(text, opts.query, opts.max_hits ?? 50) };
    if (type === "json") return fail("query: .md, .txt and .csv objects; a .json object is read whole");
    let scope;
    if (opts.section !== undefined) {
      const found = findSections(text, opts.section);
      if (found.length !== 1) return fail(found.length ? `section '${opts.section}' is ambiguous: ${found.map((s) => s.label).join(" | ")}` : `section '${opts.section}' not found`);
      scope = found[0];
    }
    const r: SearchResult = search(text, opts.query, opts.max_hits ?? 5, { scope });
    return { ok: true, ...r };
  }
  if (text.length <= maxChars) return { ok: true, content: text };
  return { ok: true, too_large: `${text.length} chars, above max_chars ${maxChars}: the outline instead; read with lines (e.g. "1-50"${type === "csv" ? ", data rows" : ""}), section or query, or a larger max_chars`, outline: outlineOf(type, text) };
}

function outlineOf(type: string, text: string): Record<string, unknown> {
  if (type === "md") { const o = outline(text, "full_text"); return { words: o.words, sections: o.sections }; }
  if (type === "csv") { const r = parseCsv(text); return r.ok ? { columns: r.rows[0], rows: r.rows.length - 1 } : { error: r.error }; }
  if (type === "json") {
    const v = JSON.parse(text);
    return Array.isArray(v) ? { array: v.length } : v && typeof v === "object" ? { keys: Object.keys(v) } : { value: typeof v };
  }
  return { lines: text.split("\n").length, words: (text.match(/\S+/g) ?? []).length };
}

// lines "a-b" (1-based, inclusive; "a" one line, "a-" to the end): .md/.txt text lines,
// .csv data rows (the header apart, as columns). Cut at max_chars on a whole line;
// first, last and total say where the piece sits, so the next call can continue.
export function parseLines(spec: string): { from: number; to: number | null } | null {
  const m = /^\s*(\d+)\s*(?:(-)\s*(\d*))?\s*$/.exec(spec);
  if (!m) return null;
  const from = Number(m[1]); const to = m[2] ? (m[3] ? Number(m[3]) : null) : from;
  return from >= 1 && (to === null || to >= from) ? { from, to } : null;
}

function byLines(type: string, text: string, spec: string, maxChars: number): ({ ok: true } & Record<string, unknown>) | Fail {
  const range = parseLines(spec);
  if (!range) return fail(`lines: "${spec}" — give "a-b", "a" or "a-" (1-based)`);
  let columns: string[] | undefined; let items: string[];
  if (type === "csv") {
    const r = parseCsv(text);
    if (!r.ok) return fail(r.error);
    [columns] = r.rows;
    const physical = text.replace(/\r?\n$/, "").split(/\r?\n/);
    // One record per line (no cell holds a line break): the rows as written; else rebuilt.
    items = physical.length === r.rows.length ? physical.slice(1) : r.rows.slice(1).map((row) => row.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","));
  } else items = text.replace(/\n$/, "").split("\n");
  const total = items.length;
  if (range.from > total) return fail(`lines: from ${range.from}, but there are ${total}${type === "csv" ? " data rows" : " lines"}`);
  const want = items.slice(range.from - 1, range.to === null ? total : Math.min(range.to, total));
  const out: string[] = []; let used = 0;
  for (const l of want) { if (out.length && used + l.length + 1 > maxChars) break; out.push(l); used += l.length + 1; }
  const last = range.from + out.length - 1;
  return { ok: true, ...(columns ? { columns: columns.join(",") } : {}), [type === "csv" ? "rows" : "text"]: out.join("\n"), first: range.from, last, total, ...(last < (range.to === null ? total : Math.min(range.to, total)) ? { cut: `at max_chars ${maxChars}; continue with lines "${last + 1}-"` } : {}) };
}

// The rows that hold every term (in any cell, matched as fh_library_read matches), in file order.
function csvQuery(text: string, query: string, maxHits: number): Record<string, unknown> {
  const r = parseCsv(text);
  if (!r.ok) return { error: r.error };
  const [columns, ...rows] = r.rows;
  const stems = [...new Set(tokens(query).map(stem))];
  const hits = stems.length ? rows.filter((row) => { const have = new Set(tokens(row.join(" ")).map(stem)); return stems.every((s) => have.has(s)); }) : [];
  const out: Record<string, unknown> = { columns, rows: hits.slice(0, maxHits), total: hits.length };
  if (hits.length > maxHits) out.more = hits.length - maxHits;
  return out;
}
