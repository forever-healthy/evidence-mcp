import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { str } from "./env.js";

// DataCite: DOIs for published work (#103, stuff/datacite/CONCEPT.md). Development only, offered with
// FH_DATACITE_ENABLED. Generic: the functions pass JSON metadata to DataCite's REST API (/dois) and return its
// answer; they know nothing about a particular publisher.
//
//   FH_DATACITE_ENABLED         the switch; off, nothing here is offered or named
//   FH_DATACITE_REPOSITORY_ID   the repository account (not the member login), e.g. ABCD.EFGHIJ
//   FH_DATACITE_PASSWORD        its password
//   FH_DATACITE_PREFIX          its prefix, 10.xxxxx
//   FH_DATACITE_API_URL         https://api.test.datacite.org or https://api.datacite.org — the choice between
//                               test and production; with the keys set it has no default
//   FH_DATACITE_SUFFIX_FORMAT   how a new DOI's suffix is drawn (####-####): # a digit, @ a letter or digit
//   FH_DATACITE_NAMESPACE       opens every new DOI's suffix when a create names none (evipedia: evipedia.4827-1936)
//   FH_DATACITE_RESOLVER_URL    where a DOI's link leads (doi_url); unset, it follows the API: https://doi.org for
//                               production, https://handle.test.datacite.org for the test system
//
// No account, no tools: without the four keys nothing is offered, reading included — DataCite holds only its own
// DOIs (a journal article's is at Crossref), so a reader without an account of its own has little to ask it.
// The guards hold for every caller: a create is always a draft (publishing is its own call; a public DOI is never
// deleted, only hidden from DataCite's search again), the server draws the suffix, a URL that already has a DOI in
// the account is refused, only a draft can be deleted, and nothing is written outside the account's prefix.

export const dataciteEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(true|1|yes|on)$/i.test(env.FH_DATACITE_ENABLED?.trim() ?? "");

const TEST = "https://api.test.datacite.org", PRODUCTION = "https://api.datacite.org";
const DEFAULT_FORMAT = "####-####";
const RESOLVER = { production: "https://doi.org", test: "https://handle.test.datacite.org" };
const LETTERS = "0123456789abcdefghjkmnpqrstvwxyz";   // no i, l, o, u: nothing that reads as another character

// Where a DOI's link leads: the resolver of the system the API belongs to, or the one named. A DOI's own characters
// stay as they are in the link, as doi.org prints them; only what would break a URL is escaped.
export function resolverUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const set = str("FH_DATACITE_RESOLVER_URL", env).replace(/\/+$/, "");
  if (/^https?:\/\/\S+$/i.test(set)) return set;
  const sys = systemOf(apiUrl(env) || PRODUCTION);
  return sys === "other" ? null : RESOLVER[sys];
}
export const doiUrl = (doi: string, resolver: string | null): string | null => (resolver ? `${resolver}/${encodeURI(doi).replace(/[?#]/g, encodeURIComponent)}` : null);

export type DataciteConfig = { api: string; repository: string; password: string; prefix: string; system: "test" | "production" | "other" };
const systemOf = (api: string): DataciteConfig["system"] => (api === PRODUCTION ? "production" : api === TEST ? "test" : "other");
const apiUrl = (env: NodeJS.ProcessEnv) => str("FH_DATACITE_API_URL", env).replace(/\/+$/, "");

// The account, when everything it needs is set; null: no tools.
export function dataciteConfig(env: NodeJS.ProcessEnv = process.env): DataciteConfig | null {
  if (!dataciteEnabled(env) || dataciteProblems(env).length) return null;
  const repository = str("FH_DATACITE_REPOSITORY_ID", env), password = str("FH_DATACITE_PASSWORD", env), prefix = str("FH_DATACITE_PREFIX", env), api = apiUrl(env);
  return repository && password && prefix && api ? { api, repository, password, prefix, system: systemOf(api) } : null;
}

// The switch on with keys missing, or in a form DataCite does not have: said at startup and in fh_info, and no tool is offered.
export function dataciteProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!dataciteEnabled(env)) return [];
  const names = ["FH_DATACITE_REPOSITORY_ID", "FH_DATACITE_PASSWORD", "FH_DATACITE_PREFIX", "FH_DATACITE_API_URL"];
  const out: string[] = [];
  const set = names.filter((n) => str(n, env));
  if (set.length < names.length) out.push(`DataCite: ${names.filter((n) => !set.includes(n)).join(", ")} unset — the fh_datacite tools are not offered${set.includes("FH_DATACITE_API_URL") ? "" : ` (FH_DATACITE_API_URL: ${TEST} or ${PRODUCTION})`}`);
  const prefix = str("FH_DATACITE_PREFIX", env);
  if (prefix && !/^10\.\d{4,9}$/.test(prefix)) out.push(`DataCite: FH_DATACITE_PREFIX "${prefix}" is not a DOI prefix (10.xxxxx)`);
  const api = apiUrl(env);
  if (api && !/^https:\/\/[^/\s]+$/i.test(api)) out.push(`DataCite: FH_DATACITE_API_URL "${api}" is not an https address (${TEST} or ${PRODUCTION})`);
  const res = str("FH_DATACITE_RESOLVER_URL", env);
  if (res && !/^https?:\/\/\S+$/i.test(res)) out.push(`DataCite: FH_DATACITE_RESOLVER_URL "${res}" is not a web address`);
  else if (!res && api && systemOf(api) === "other") out.push(`DataCite: FH_DATACITE_RESOLVER_URL unset for the API at ${api} — answers carry no doi_url`);
  const ns = str("FH_DATACITE_NAMESPACE", env);
  if (ns && !NAMESPACE.test(ns.toLowerCase())) out.push(`DataCite: FH_DATACITE_NAMESPACE "${ns}" — lower-case letters, digits and -, at most 32 characters; new DOIs get no namespace`);
  const f = str("FH_DATACITE_SUFFIX_FORMAT", env);
  if (f && !formatOk(f)) out.push(`DataCite: FH_DATACITE_SUFFIX_FORMAT "${f}" — # and @ to draw (at least six), else lower-case letters, digits, . _ -; ${DEFAULT_FORMAT} is used`);
  return out;
}

// For fh_info: which system and account the functions talk to (never the password).
export function dataciteInfo(env: NodeJS.ProcessEnv = process.env): { system: string; api: string; resolver: string | null; repository: string; prefix: string; namespace?: string; new_doi: string } | null {
  const c = dataciteConfig(env);
  if (!c) return null;
  return { system: c.system, api: c.api, resolver: resolverUrl(env), repository: c.repository, prefix: c.prefix, ...(defaultNamespace(env) ? { namespace: defaultNamespace(env) } : {}), new_doi: exampleDoi(c.prefix, defaultNamespace(env), suffixFormat(env)) };
}

// ---- the suffix ----

// A namespace opens the suffix: "evipedia" gives evipedia.4827-1936. The one in the settings is used when a create
// names none, so a publisher's DOIs all look alike without every call having to say so — a DOI string is for good.
const NAMESPACE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const defaultNamespace = (env: NodeJS.ProcessEnv = process.env): string | undefined => { const n = str("FH_DATACITE_NAMESPACE", env).toLowerCase(); return NAMESPACE.test(n) ? n : undefined; };

// A format draws at least a million different suffixes (six drawn characters), so a clash is rare and a retry settles it.
const formatOk = (f: string) => /^[a-z0-9._\-#@]+$/.test(f) && (f.match(/[#@]/g)?.length ?? 0) >= 6;
export const suffixFormat = (env: NodeJS.ProcessEnv = process.env): string => { const f = str("FH_DATACITE_SUFFIX_FORMAT", env); return f && formatOk(f) ? f : DEFAULT_FORMAT; };
export function drawSuffix(namespace: string | undefined, format = suffixFormat(), rand: (n: number) => number = randomInt): string {
  const drawn = format.replace(/[#@]/g, (c) => (c === "#" ? String(rand(10)) : LETTERS[rand(LETTERS.length)]));
  return namespace ? `${namespace}.${drawn}` : drawn;
}

// What a new DOI looks like, for fh_info and the create tool: the drawn characters shown as 4827-1936….
export const exampleDoi = (prefix: string, namespace: string | undefined, format = suffixFormat()): string => { const digits = "48271936", letters = "k3vf9a21"; let i = 0; return `${prefix}/${drawSuffix(namespace, format.replace(/[#@]/g, (c) => { const x = (c === "#" ? digits : letters)[i % 8]; i++; return x; }), () => 0)}`; };

// ---- the API ----

export type Answer = { status: number; json: unknown };
export type Call = (method: string, url: string, body?: unknown, auth?: string) => Promise<Answer>;
const TIMEOUT_SECS = 30;
const live: Call = async (method, url, body, auth) => {
  const signal = AbortSignal.timeout(TIMEOUT_SECS * 1000);
  let r: Response;
  try {
    r = await fetch(url, { method, signal, headers: { accept: "application/vnd.api+json", ...(body === undefined ? {} : { "content-type": "application/vnd.api+json" }), ...(auth ? { authorization: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (e) { throw new Error(signal.aborted ? `DataCite: timeout ${TIMEOUT_SECS}s` : `DataCite: ${e instanceof Error ? e.message : String(e)}`); }
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { errors: [{ title: text.slice(0, 200) }] }; }
  return { status: r.status, json };
};

export type Deps = { cfg: DataciteConfig | null; api: string; resolver: string | null; namespace?: string; call: Call; dir: string; now: () => number };
export const liveDeps = (dir: string, env: NodeJS.ProcessEnv = process.env): Deps => {
  const cfg = dataciteConfig(env);
  return { cfg, api: cfg?.api ?? (apiUrl(env) || PRODUCTION), resolver: resolverUrl(env), namespace: defaultNamespace(env), call: live, dir, now: Date.now };
};

type Attributes = Record<string, unknown> & { doi?: string; state?: string; url?: string | null; titles?: { title?: string }[]; publicationYear?: number; created?: string; registered?: string; updated?: string };
type Record_ = { id?: string; attributes?: Attributes };
export type Outcome<T> = ({ ok: true } & T) | { ok: false; error: string; input?: true };   // input: the caller's mistake

const auth = (c: DataciteConfig) => "Basic " + Buffer.from(`${c.repository}:${c.password}`).toString("base64");
const errors = (a: Answer): string => {
  const list = (a.json as { errors?: { source?: string; title?: string; detail?: string }[] } | null)?.errors ?? [];
  const said = list.map((e) => [e.source, e.title ?? e.detail].filter(Boolean).join(": ")).filter(Boolean).join("; ");
  return said || `HTTP ${a.status}`;
};
const failed = (a: Answer, what: string): { ok: false; error: string } => ({ ok: false, error: `DataCite refused the ${what} (HTTP ${a.status}): ${errors(a)}${a.status === 401 || a.status === 403 ? " — the repository ID, its password or the system (test or production) in the settings do not fit" : ""}` });

// "doi:10.x/y", "https://doi.org/10.x/y" and "10.X/Y" are one DOI: lower case, as DataCite stores it.
export function normalDoi(raw: string): string | null {
  const d = raw.trim().replace(/^doi:\s*/i, "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : null;
}
const badDoi = (raw: string) => ({ ok: false as const, input: true as const, error: `"${raw}" is not a DOI (10.xxxxx/suffix)` });
const path = (doi: string) => "/dois/" + encodeURIComponent(doi);

async function fetchDoi(doi: string, d: Deps): Promise<{ attrs: Attributes } | { missing: true } | { error: string }> {
  const a = await d.call("GET", d.api + path(doi), undefined, d.cfg ? auth(d.cfg) : undefined);
  if (a.status === 404) return { missing: true };
  if (a.status !== 200) return { error: failed(a, "read").error };
  const attrs = (a.json as { data?: Record_ } | null)?.data?.attributes;
  return attrs ? { attrs } : { error: "DataCite answered without a record" };
}

// ---- reading ----

// What a record's metadata is: everything but the fields the answer carries on its own, DataCite's bookkeeping
// and its counters, and the XML copy of the same metadata.
const NOT_METADATA = /^(doi|prefix|suffix|url|state|created|registered|updated|published|xml|contentUrl|metadataVersion|schemaVersion|source|isActive|reason|landingPage|agency|.*Count|.*OverTime)$/;
const LONG = 25;
const filled = (v: unknown): boolean => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
export function metadataOf(attrs: Attributes, fields?: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (NOT_METADATA.test(k) || !filled(v)) continue;
    if (fields?.length) { if (fields.includes(k)) out[k] = v; continue; }
    out[k] = Array.isArray(v) && v.length > LONG ? `${v.length} entries — name "${k}" in fields to read them` : v;
  }
  return out;
}
const head = (attrs: Attributes, doi: string, d: Deps) => { const name = attrs.doi ?? doi, link = doiUrl(name, d.resolver); return { doi: name, ...(link ? { doi_url: link } : {}), state: attrs.state ?? null, url: attrs.url ?? null }; };
const day = (t: unknown) => (typeof t === "string" ? t.slice(0, 10) : null);

export type DoiRecord = { doi: string; doi_url?: string; state: string | null; url: string | null; created: string | null; registered: string | null; updated: string | null; metadata: Record<string, unknown> };
export async function getDoi(raw: string, fields: string[] | undefined, d: Deps): Promise<Outcome<{ record: DoiRecord }>> {
  if (!d.cfg) return NO_ACCOUNT;
  const doi = normalDoi(raw);
  if (!doi) return badDoi(raw);
  const r = await fetchDoi(doi, d);
  if ("error" in r) return { ok: false, error: r.error };
  if ("missing" in r) return { ok: false, input: true, error: `DataCite has no DOI ${doi} in its ${systemOf(d.api)} system${ours(doi, d.cfg) ? "" : ", or it is another account's draft"}. A journal article's DOI is registered at Crossref, not here: fh_library_add reads it.` };
  return { ok: true, record: { ...head(r.attrs, doi, d), created: day(r.attrs.created), registered: day(r.attrs.registered), updated: day(r.attrs.updated), metadata: metadataOf(r.attrs, fields) } };
}

export const LIST_COLUMNS = ["doi", "doi_url", "state", "url", "title", "year", "created", "updated"] as const;
export const LIST_MAX = 100;
type Row = [string, string | null, string | null, string | null, string | null, number | null, string | null, string | null];
const rowOf = (x: Record_, resolver: string | null): Row => { const a = x.attributes ?? {}, doi = a.doi ?? x.id ?? ""; return [doi, doiUrl(doi, resolver), a.state ?? null, a.url ?? null, a.titles?.[0]?.title ?? null, a.publicationYear ?? null, day(a.created), day(a.updated)]; };
const quoted = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
const sameUrl = (u: string) => u.trim().replace(/\/+$/, "").replace(/^(https?:\/\/[^/]+)/i, (h) => h.toLowerCase());
const urlQuery = (url: string) => { const u = sameUrl(url); return `url:(${quoted(u)} OR ${quoted(u + "/")})`; };

export type ListArgs = { state?: "draft" | "registered" | "findable"; url?: string; query?: string; max_results?: number; page?: number };
export async function listDois(args: ListArgs, d: Deps): Promise<Outcome<{ total: number; columns: typeof LIST_COLUMNS; rows: Row[] }>> {
  if (!d.cfg) return { ok: false, error: "no DataCite account configured" };
  const q = [args.url?.trim() && urlQuery(args.url), args.query?.trim() && (args.url?.trim() ? `(${args.query.trim()})` : args.query.trim())].filter(Boolean).join(" AND ");
  const p = new URLSearchParams({ "client-id": d.cfg.repository.toLowerCase(), "page[size]": String(Math.min(LIST_MAX, args.max_results ?? 25)), "page[number]": String(args.page ?? 1), sort: "-created" });
  if (args.state) p.set("state", args.state);
  if (q) p.set("query", q);
  const a = await d.call("GET", `${d.api}/dois?${p}`, undefined, auth(d.cfg));
  if (a.status !== 200) return failed(a, "list");
  const j = a.json as { data?: Record_[]; meta?: { total?: number } } | null;
  const rows = (j?.data ?? []).map((x) => rowOf(x, d.resolver));
  return { ok: true, total: j?.meta?.total ?? rows.length, columns: LIST_COLUMNS, rows };
}

// ---- the duplicate check ----

// DataCite's list reads a search index that lags behind a write (seen on the test system: found 8 s later once,
// 2 minutes later another time), so the DOIs this library created are also kept here for a while and asked for by name,
// which has no lag. What another library created a moment ago is not seen: two creates for one URL from two
// machines at the same moment both pass.
const RECENT_MS = 15 * 60 * 1000;
type Created = { doi: string; url: string; at: number };
const recentFile = (dir: string) => join(dir, "datacite", "created.jsonl");
function readRecent(d: Deps): Created[] {
  try { return readFileSync(recentFile(d.dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Created).filter((c) => d.now() - c.at < RECENT_MS); } catch { return []; }
}
function writeRecent(d: Deps, list: Created[]): void {
  try { const f = recentFile(d.dir); if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, list.map((c) => JSON.stringify(c)).join("\n") + (list.length ? "\n" : "")); } catch { /* the index still has it a moment later */ }
}
const remember = (d: Deps, doi: string, url: string | null) => writeRecent(d, [...readRecent(d).filter((c) => c.doi !== doi), ...(url ? [{ doi, url, at: d.now() }] : [])]);

// The account's DOI that already points at this URL (not `except`), or null.
async function doiForUrl(url: string, d: Deps, except?: string): Promise<{ doi: string; state: string | null } | null | { error: string }> {
  const want = sameUrl(url);
  for (const c of readRecent(d)) {
    if (c.doi === except || sameUrl(c.url) !== want) continue;
    const r = await fetchDoi(c.doi, d);
    if ("attrs" in r && r.attrs.url && sameUrl(r.attrs.url) === want) return { doi: c.doi, state: r.attrs.state ?? null };
  }
  const l = await listDois({ url, max_results: LIST_MAX }, d);
  if (!l.ok) return { error: l.error };
  const hit = l.rows.find((r) => r[0] !== except && r[3] && sameUrl(r[3]) === want);
  return hit ? { doi: hit[0], state: hit[2] } : null;
}

// ---- writing ----

// Set by the server or by its own argument, never by the metadata: the DOI, its state and the URL.
const NOT_WRITABLE = /^(doi|prefix|suffix|event|state|url|created|registered|updated|client|xml)$/;
const writable = (metadata: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(metadata).filter(([k]) => !NOT_WRITABLE.test(k)));
const httpUrl = (u: string): boolean => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
// What DataCite asks of a DOI before it can be made public.
export function missingToPublish(attrs: Attributes): string[] {
  const types = attrs.types as { resourceTypeGeneral?: string } | undefined;
  return [
    !attrs.url && "url",
    !(attrs.titles as unknown[] | undefined)?.length && "titles",
    !(attrs.creators as unknown[] | undefined)?.length && "creators",
    !filled(attrs.publisher) && "publisher",
    !attrs.publicationYear && "publicationYear",
    !types?.resourceTypeGeneral && "types.resourceTypeGeneral",
  ].filter((x): x is string => !!x);
}
const NO_ACCOUNT = { ok: false as const, error: "no DataCite account configured" };
const ours = (doi: string, c: DataciteConfig) => doi.startsWith(c.prefix + "/");
const notOurs = (doi: string, c: DataciteConfig) => ({ ok: false as const, input: true as const, error: `${doi} is not in this account's prefix ${c.prefix}` });

export type Written = { doi: string; doi_url?: string; state: string | null; url: string | null; missing_to_publish?: string[] };
const written = (attrs: Attributes, doi: string, d: Deps): Written => { const m = missingToPublish(attrs); return { ...head(attrs, doi, d), ...(attrs.state === "draft" && m.length ? { missing_to_publish: m } : {}) }; };
const dataOf = (a: Answer): Attributes => (a.json as { data?: Record_ } | null)?.data?.attributes ?? {};

const DRAWS = 5;
export async function createDoi(args: { url: string; metadata?: Record<string, unknown>; namespace?: string }, d: Deps, draw: (namespace?: string) => string = drawSuffix): Promise<Outcome<Written>> {
  if (!d.cfg) return NO_ACCOUNT;
  const url = args.url.trim(), namespace = args.namespace?.trim().toLowerCase() || d.namespace;
  if (!httpUrl(url)) return { ok: false, input: true, error: `url "${args.url}" is not an http(s) address: the landing page of the work` };
  if (namespace && !NAMESPACE.test(namespace)) return { ok: false, input: true, error: `namespace "${args.namespace}": lower-case letters, digits and -, at most 32 characters` };
  const dup = await doiForUrl(url, d);
  if (dup && "error" in dup) return { ok: false, error: dup.error };
  if (dup) return { ok: false, input: true, error: `this URL already has a DOI: ${dup.doi} (${dup.state}). Change that one (fh_datacite_update_doi) instead of creating a second.` };
  for (let i = 0; i < DRAWS; i++) {
    const doi = `${d.cfg.prefix}/${draw(namespace)}`;
    const a = await d.call("POST", d.api + "/dois", { data: { type: "dois", attributes: { ...writable(args.metadata ?? {}), doi, url } } }, auth(d.cfg));   // no event: a draft
    if (a.status === 201) { remember(d, doi, url); return { ok: true, ...written({ ...dataOf(a), doi }, doi, d) }; }
    if (a.status === 422 && /already been taken/i.test(errors(a))) continue;   // the drawn suffix exists: draw again
    return failed(a, "create");
  }
  return { ok: false, error: `${DRAWS} drawn suffixes in a row exist already — FH_DATACITE_SUFFIX_FORMAT is too short for the number of DOIs` };
}

export async function updateDoi(args: { doi: string; metadata?: Record<string, unknown>; url?: string }, d: Deps): Promise<Outcome<Written>> {
  if (!d.cfg) return NO_ACCOUNT;
  const doi = normalDoi(args.doi);
  if (!doi) return badDoi(args.doi);
  if (!ours(doi, d.cfg)) return notOurs(doi, d.cfg);
  const url = args.url?.trim() || undefined, attributes = writable(args.metadata ?? {});
  if (url && !httpUrl(url)) return { ok: false, input: true, error: `url "${args.url}" is not an http(s) address` };
  if (!url && !Object.keys(attributes).length) return { ok: false, input: true, error: "nothing to change: give metadata, url or both" };
  const now = await fetchDoi(doi, d);
  if ("error" in now) return { ok: false, error: now.error };
  if ("missing" in now) return { ok: false, input: true, error: `no DOI ${doi} in this account` };   // a PUT would create it, and not as a draft drawn here
  if (url && (!now.attrs.url || sameUrl(now.attrs.url) !== sameUrl(url))) {
    const dup = await doiForUrl(url, d, doi);
    if (dup && "error" in dup) return { ok: false, error: dup.error };
    if (dup) return { ok: false, input: true, error: `this URL already has a DOI: ${dup.doi} (${dup.state})` };
  }
  const a = await d.call("PUT", d.api + path(doi), { data: { type: "dois", attributes: { ...attributes, ...(url ? { url } : {}) } } }, auth(d.cfg));
  if (a.status !== 200) return failed(a, "update");
  if (url) remember(d, doi, url);
  return { ok: true, ...written({ ...now.attrs, ...dataOf(a) }, doi, d) };
}

export async function publishDoi(raw: string, d: Deps): Promise<Outcome<Written & { already?: true }>> {
  if (!d.cfg) return NO_ACCOUNT;
  const doi = normalDoi(raw);
  if (!doi) return badDoi(raw);
  if (!ours(doi, d.cfg)) return notOurs(doi, d.cfg);
  const now = await fetchDoi(doi, d);
  if ("error" in now) return { ok: false, error: now.error };
  if ("missing" in now) return { ok: false, input: true, error: `no DOI ${doi} in this account` };
  if (now.attrs.state === "findable") return { ok: true, ...head(now.attrs, doi, d), already: true };
  const missing = missingToPublish(now.attrs);
  if (missing.length) return { ok: false, input: true, error: `${doi} cannot be made public yet, its metadata lacks: ${missing.join(", ")} (fh_datacite_update_doi)` };
  const a = await d.call("PUT", d.api + path(doi), { data: { type: "dois", attributes: { event: "publish" } } }, auth(d.cfg));
  if (a.status !== 200) return failed(a, "publish");
  const attrs = { ...now.attrs, ...dataOf(a) };
  if (attrs.state !== "findable") return { ok: false, error: `DataCite answered, but ${doi} is ${attrs.state}, not findable` };
  return { ok: true, ...head(attrs, doi, d) };
}

// Public → registered: out of DataCite's search and public API, while the DOI still resolves to its URL. The way
// back from a publish made by mistake; publishing again makes it public once more.
export async function hideDoi(raw: string, d: Deps): Promise<Outcome<Written & { already?: true }>> {
  if (!d.cfg) return NO_ACCOUNT;
  const doi = normalDoi(raw);
  if (!doi) return badDoi(raw);
  if (!ours(doi, d.cfg)) return notOurs(doi, d.cfg);
  const now = await fetchDoi(doi, d);
  if ("error" in now) return { ok: false, error: now.error };
  if ("missing" in now) return { ok: false, input: true, error: `no DOI ${doi} in this account` };
  if (now.attrs.state === "registered") return { ok: true, ...head(now.attrs, doi, d), already: true };
  if (now.attrs.state !== "findable") return { ok: false, input: true, error: `${doi} is ${now.attrs.state}: only a public DOI can be hidden. A draft is not public; delete it if it is not needed (fh_datacite_delete_doi).` };
  const a = await d.call("PUT", d.api + path(doi), { data: { type: "dois", attributes: { event: "hide" } } }, auth(d.cfg));
  if (a.status !== 200) return failed(a, "hide");
  const attrs = { ...now.attrs, ...dataOf(a) };
  if (attrs.state !== "registered") return { ok: false, error: `DataCite answered, but ${doi} is ${attrs.state}, not registered` };
  return { ok: true, ...head(attrs, doi, d) };
}

export async function deleteDoi(raw: string, d: Deps): Promise<Outcome<{ doi: string; deleted: true }>> {
  if (!d.cfg) return NO_ACCOUNT;
  const doi = normalDoi(raw);
  if (!doi) return badDoi(raw);
  if (!ours(doi, d.cfg)) return notOurs(doi, d.cfg);
  const now = await fetchDoi(doi, d);
  if ("error" in now) return { ok: false, error: now.error };
  if ("missing" in now) return { ok: false, input: true, error: `no DOI ${doi} in this account` };
  if (now.attrs.state !== "draft") return { ok: false, input: true, error: `${doi} is ${now.attrs.state}: only a draft can be deleted. A DOI that was public stays for good; its metadata and URL can be changed (fh_datacite_update_doi)${now.attrs.state === "findable" ? ", and it can be hidden from DataCite's search (fh_datacite_hide_doi)" : ""}.` };
  const a = await d.call("DELETE", d.api + path(doi), undefined, auth(d.cfg));
  if (a.status !== 204 && a.status !== 200) return failed(a, "delete");
  remember(d, doi, null);
  return { ok: true, doi, deleted: true };
}
