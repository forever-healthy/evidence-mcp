import { builtinPrompt } from "./prompts.js";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { num, str } from "./env.js";
import { writeAtomic } from "./entry.js";

// Abstract screening for the evidence map (stuff/evmap/architecture.md → What the screening extracts). A small model reads one abstract with the caller's screening
// prompt and answers fixed fields (structured output); the score is computed from
// them elsewhere, never asked of the model. Results are cached per paper under
// screen/<key>/ in the library, the key being the model and the filled prompt
// without the paper: a re-run with the same topic and prompt screens only new papers.

export const screenParallel = (env: NodeJS.ProcessEnv = process.env): number => num("FH_EVMAP_SCREENING_PARALLEL", 400, env, (n) => n >= 1 && n <= 400 && Number.isInteger(n));

// The screening model: FH_EVMAP_SCREENING_PROVIDER names the API and with it the
// hosted endpoint; FH_EVMAP_SCREENING_URL replaces that endpoint. Without a provider:
// a URL is a model server of your own speaking the OpenAI-compatible chat API (vLLM,
// llama.cpp, Ollama, LM Studio — the URL up to /v1), a key alone names its provider
// by its prefix (sk-ant- → anthropic). Neither: no screening.
export const SCREEN_PROVIDERS = {
  anthropic: { api: "anthropic", url: "https://api.anthropic.com", keyPrefix: "sk-ant-" },
  openai: { api: "openai", url: "https://api.openai.com/v1", keyPrefix: "sk-" },
  // Gemini through Google's OpenAI-compatible endpoint (speed test 2026-11-19: flash-lite 82 papers/s, Haiku 35)
  google: { api: "openai", url: "https://generativelanguage.googleapis.com/v1beta/openai", keyPrefix: "AIza" },
  // OpenRouter: one key for many providers' models (the open ones too), OpenAI-compatible; the
  // model by its OpenRouter name. Reasoning off: a screening answer needs none, and a reasoning
  // model left on can spend its whole budget thinking (Liquid's, 2026-11-21).
  openrouter: { api: "openai", url: "https://openrouter.ai/api/v1", keyPrefix: "sk-or-", body: { reasoning: { enabled: false } } },
  // xAI (Grok), OpenAI-compatible (2026-11-22; models from its /v1/models list)
  xai: { api: "openai", url: "https://api.x.ai/v1", keyPrefix: "xai-" },
} as const;
export type ScreenProvider = keyof typeof SCREEN_PROVIDERS;
export type ScreenConfig = { ok: true; provider: ScreenProvider; api: "anthropic" | "openai"; url: string; model: string; key: string; vars?: Vars } | { ok: false; reason: string };

// Sections, for development (not in the public docs): FH_EVMAP_<PROVIDER>_MODEL,
// _URL, _API_KEY, one set per provider, so several keys sit in one .env and a switch is one word
// (as FH_VERIFY_<PROVIDER>_*). A section's field wins over the plain variable. forProvider: that
// provider's settings whatever FH_EVMAP_SCREENING_PROVIDER says (the ranking: anthropic).
export function screenConfig(env: NodeJS.ProcessEnv = process.env, forProvider?: ScreenProvider): ScreenConfig {
  const field = (p: string | null, f: "MODEL" | "URL" | "API_KEY") => (p && str(`FH_EVMAP_${p.toUpperCase()}_${f}`, env)) || str(`FH_EVMAP_SCREENING_${f}`, env);
  const named = forProvider ?? str("FH_EVMAP_SCREENING_PROVIDER", env).toLowerCase();
  if (named && !(named in SCREEN_PROVIDERS)) return { ok: false, reason: `FH_EVMAP_SCREENING_PROVIDER: ${named}, not one of ${Object.keys(SCREEN_PROVIDERS).join(", ")}` };
  // The provider is named (FH_EVMAP_SCREENING_PROVIDER), never guessed from a key, as for claim verification;
  // the one exception: no provider and a URL — a model server of your own (OpenAI-compatible API).
  let provider: ScreenProvider | null = named ? named as ScreenProvider : null;
  const url = field(provider, "URL").replace(/\/+$/, "");
  // The key: the provider's section, the screening's own, else the key of another part (discovery,
  // ranking) that names the same provider — the three share a key, never a provider or a model.
  const shared = (p: string | null) => (p && !forProvider ? (["DISCOVERY", "RANKING"] as const).filter((o) => str(`FH_EVMAP_${o}_PROVIDER`, env).toLowerCase() === p).map((o) => str(`FH_EVMAP_${o}_API_KEY`, env)).find(Boolean) : "") || "";
  const key = field(provider, "API_KEY") || shared(provider);
  if (!provider && url) provider = "openai";
  const anyKey = key || (Object.keys(SCREEN_PROVIDERS) as ScreenProvider[]).some((p) => str(`FH_EVMAP_${p.toUpperCase()}_API_KEY`, env));
  if (!provider) return { ok: false, reason: anyKey ? `FH_EVMAP_SCREENING_PROVIDER: not set — ${Object.keys(SCREEN_PROVIDERS).join(", ")}` : "no screening model (FH_EVMAP_SCREENING_PROVIDER, FH_EVMAP_SCREENING_API_KEY)" };
  const p = SCREEN_PROVIDERS[provider];
  // The model is named too, never a default: whoever sets the map up chooses its three models.
  const model = field(provider, "MODEL");
  if (!model) return { ok: false, reason: `FH_EVMAP_SCREENING_MODEL: not set — the screening model for ${provider}, e.g. a fast one` };
  if (!key && !url) return { ok: false, reason: `FH_EVMAP_SCREENING_API_KEY: needed for ${provider}'s hosted API` };
  // The variable each value came from (or the section's own name when neither is set): for the hints.
  const from = (f: "MODEL" | "URL" | "API_KEY") => { const own = `FH_EVMAP_${provider!.toUpperCase()}_${f}`; return str(own, env) || !str(`FH_EVMAP_SCREENING_${f}`, env) ? own : `FH_EVMAP_SCREENING_${f}`; };
  return { ok: true, provider, api: p.api, url: url || p.url, model, key, vars: { key: from("API_KEY"), model: from("MODEL"), url: from("URL") } };
}

// The built-in screening prompt: evmap/screening.md itself (src/prompts.ts).
export const DEFAULT_SCREENING = builtinPrompt("screening");

export const FIELDS = ["relevance", "population", "design", "n", "outcome", "finding", "aspect", "reason"] as const;
export type Screened = { relevance: "direct" | "indirect" | "background" | "off-topic"; population: "humans" | "animals" | "in vitro" | "none"; design: string; n: number | null; outcome: "hard" | "surrogate" | "none"; finding: "benefit" | "no effect" | "harm" | "mixed" | "none"; aspect: "efficacy" | "safety" | "mechanism" | "dosing" | "interaction" | "other"; reason: string };

// What kind of study an article is: the same for every topic, so stored with the article in the library
// (src/characteristics.ts) — these definitions serve the screening's answer and the library's own small prompt alike.
export const CHARACTERISTICS = {
  population: { type: "string", enum: ["humans", "animals", "in vitro", "none"] },
  design: { type: "string", description: "study design, e.g. meta-analysis, systematic review, RCT, cohort, case-control, case report, review, animal study, in vitro" },
  n: { type: ["integer", "null"], description: "participants, if the abstract states it" },
} as const;

export const SCHEMA = {
  type: "object",
  properties: {
    relevance: { type: "string", enum: ["direct", "indirect", "background", "off-topic"], description: "direct: the topic's intervention itself studied in humans, any outcome, with or without comparators; indirect: a broader category it belongs to, a related intervention, or it pooled with others without its own result; background: animal, in vitro, mechanism, epidemiology; off-topic: not about the topic" },
    ...CHARACTERISTICS,   // population, design, n: what kind of study it is — the library's definitions, stored with the article
    outcome: { type: "string", enum: ["hard", "surrogate", "none"], description: "hard: death, incidence, clinical events; surrogate: biomarker, imaging" },
    finding: { type: "string", enum: ["benefit", "no effect", "harm", "mixed", "none"], description: "the intervention's effect; harm: caused by the intervention, not by the effect it achieved" },
    aspect: { type: "string", enum: ["efficacy", "safety", "mechanism", "dosing", "interaction", "other"], description: "efficacy: any benefit outcome, null results too; safety: adverse effects" },
    reason: { type: "string", description: "one sentence: what the paper adds to the topic" },
  },
  required: [...FIELDS],
  additionalProperties: false,
} as const;

export const fill = (prompt: string, topic: string, paper: string): string => prompt.split("{{topic}}").join(topic).split("{{article}}").join(paper);

// The schema is part of the key: a changed field definition screens again.
export const cacheKey = (model: string, prompt: string, topic: string): string => createHash("sha256").update(JSON.stringify([model, fill(prompt, topic, ""), SCHEMA])).digest("hex").slice(0, 16);

export type Ask = (text: string) => Promise<Screened>;

// A failed screening call, said so the calling model knows what happened and whether
// trying again can help: the provider's own message, then what to check.
// One abstract's answer takes 1–3 s (speed test 2026-11-19); past this the call is given up.
export const SCREEN_TIMEOUT_MS = 60_000;

export class ScreenError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
// The model declined to screen the abstract (safety filter): final for this abstract and
// prompt, so cached like an answer, logged as refused, not offered for a retry.
export class Refusal extends Error {
  constructor() { super("refusal"); }
}
// The settings a hint names: the variables the values came from (a provider's section or the plain one).
export type Vars = { key: string; model: string; url: string };
const PLAIN: Vars = { key: "FH_EVMAP_SCREENING_API_KEY", model: "FH_EVMAP_SCREENING_MODEL", url: "FH_EVMAP_SCREENING_URL" };

export function hint(status: number | undefined, message: string, v: Vars = PLAIN): string {
  if (status === 401 || status === 403 || /api key|api_key|x-api-key|unauthori[sz]ed|permission/i.test(message)) return `the API key is missing, wrong or has no access to the model — ${v.key} in the server's .env`;
  if (status === 404 || /model.*(not found|does not exist)|not_found/i.test(message)) return `the model or the endpoint does not exist — ${v.model}, ${v.url} in the server's .env`;
  if (/quota|spend|billing|credit balance|insufficient/i.test(message)) return `the provider account's quota or spending limit is used up — raise it in the provider's console, or use another key (${v.key})`;
  if (status === 429) return "rate limit still hit after retries — lower FH_EVMAP_SCREENING_PARALLEL or try again later";
  if (status === 400) return `the provider refused the request; the model may not support structured output (a JSON schema) — ${v.model}`;
  if (status && status >= 500) return "the provider's service is failing — try again later";
  if (/timed? ?out|timeout/i.test(message)) return `no answer in time — the provider is slow or overloaded: try again later, or another model (${v.model})`;
  if (/connect|fetch failed|ECONNREFUSED|ENOTFOUND|abort/i.test(message)) return `the endpoint cannot be reached — ${v.url} in the server's .env, and the model server running`;
  if (/JSON|no answer|max_tokens/i.test(message)) return `the model did not answer with the fields asked for — a model that supports structured output, ${v.model}`;
  if (/refusal/.test(message)) return "the model refused the request";
  return "";
}
// A provider's error body is JSON with a message somewhere; that message alone, not the whole body.
export function shortMessage(raw: string): string {
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  const status = /^(?:HTTP )?(\d{3})\b/.exec(raw)?.[1];
  return (m ? `${status ? `${status} ` : ""}${m[1].replace(/\\"/g, '"')}` : raw).replace(/\s+/g, " ").slice(0, 200);
}
export const describe = (e: unknown, where: string, v: Vars = PLAIN): string => {
  const status = statusOf(e);
  const raw = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ");
  const message = shortMessage(raw);
  const h = hint(status, raw, v);
  return `${where}: ${status && !message.includes(String(status)) ? `HTTP ${status} ` : ""}${message}${h ? ` — ${h}` : ""}`;
};

export const where = (c: Extract<ScreenConfig, { ok: true }>): string => `${c.provider} ${c.model} at ${c.url}`;

// The provider's call, its errors described with where they came from.
export function askFor(c: Extract<ScreenConfig, { ok: true }>): Ask {
  const ask = rawAsk(c);
  return async (text) => { try { return await ask(text); } catch (e) { throw e instanceof Refusal ? e : new Error(describe(e, where(c), c.vars)); } };
}
// The provider's call with its errors as they come (the key pool reads them, src/keypool.ts).
// seen: the answer's headers — Anthropic states the key's rate limits there.
export type Headers = { get(name: string): string | null };
export function rawAsk(c: Extract<ScreenConfig, { ok: true }>, seen?: (h: Headers) => void): Ask {
  return c.api === "anthropic" ? anthropicAsk(c.key, c.model, c.url, seen) : openaiAsk(c.url, c.key, c.model, fetch, (SCREEN_PROVIDERS[c.provider] as { body?: Record<string, unknown> }).body);
}
export const statusOf = (e: unknown): number | undefined => e instanceof ScreenError ? e.status : e instanceof Anthropic.APIError ? e.status : undefined;

export function anthropicAsk(apiKey: string, model: string, baseURL?: string, seen?: (h: Headers) => void): Ask {
  const client = new Anthropic({ apiKey, baseURL, maxRetries: 6, timeout: SCREEN_TIMEOUT_MS });   // 429 and 5xx: the SDK waits and retries
  return async (text) => {
    const { data: r, response } = await client.messages.create({
      model,
      max_tokens: 2048,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: text }],
    } as Anthropic.MessageCreateParamsNonStreaming).withResponse();
    seen?.(response.headers);
    if (r.stop_reason === "refusal") throw new Refusal();
    if (r.stop_reason === "max_tokens") throw new Error("max_tokens: the answer was cut off");
    const block = r.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!block) throw new Error("no answer");
    return parseAnswer(block.text);
  };
}

// The OpenAI chat completions API, which OpenAI and most model servers speak:
// response_format json_schema (strict) for the fields; 429 and 5xx wait and retry.
// extra: fields a provider needs in the request besides the standard ones (OpenRouter: reasoning off).
// A model that will not run without reasoning ("Reasoning is mandatory", OpenRouter) gets the least
// there is (effort minimal), for this and every later call.
export function openaiAsk(baseUrl: string, apiKey: string, model: string, fetchImpl: typeof fetch = fetch, extra: Record<string, unknown> = {}): Ask {
  let fields = extra;
  return async (text) => {
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      const sent = fields;   // the fields this request goes out with (several calls run at once)
      try { r = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ ...sent, model, messages: [{ role: "user", content: text }], response_format: { type: "json_schema", json_schema: { name: "screening", strict: true, schema: SCHEMA } } }),
        signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS),
      }); } catch (e) { throw new ScreenError(`cannot connect: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}`); }
      if ((r.status === 429 || r.status >= 500) && attempt < 6) { await new Promise((ok) => setTimeout(ok, Math.min(30_000, 1000 * 2 ** attempt))); continue; }
      if (!r.ok) {
        const why = (await r.text()).replace(/\s+/g, " ").slice(0, 2000);
        if (r.status === 400 && sent.reasoning && /reasoning is mandatory/i.test(why) && (sent.reasoning as { effort?: string }).effort !== "minimal") { fields = { ...sent, reasoning: { effort: "minimal" } }; attempt--; continue; }
        throw new ScreenError(`HTTP ${r.status} ${why}`, r.status);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await r.json();
      const choice = body?.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error("max_tokens: the answer was cut off");
      const content = choice?.message?.content;
      if (typeof content !== "string") throw choice?.message?.refusal ? new Refusal() : new Error("no answer");
      return parseAnswer(content);
    }
  };
}

// The answer as the fields; anything else is an error, not a paper marked off-topic.
export function parseAnswer(text: string): Screened {
  let a: Partial<Screened>;
  try { a = JSON.parse(text); } catch { throw new Error(`the answer is not JSON: ${text.slice(0, 80)}`); }
  if (!a || typeof a !== "object" || !SCHEMA.properties.relevance.enum.includes(a.relevance as never)) throw new Error(`the answer has no valid relevance: ${text.slice(0, 80)}`);
  // A stray character after the sentence (a model slip: "…increase.}") is cut.
  if (typeof a.reason === "string") a.reason = a.reason.replace(/[\s{}[\]"]+$/, "");
  return a as Screened;
}

export type ScreenResult = { pmid: string; screened?: Screened; error?: string; refused?: true; cached: boolean };

// Screens the papers, at most `parallel` at once; paper(pmid) gives the text for {{article}}.
// note(result, ms): called after every model call (not for cached answers) — one log line each.
// done(result): called for every paper as its answer is there, a cached one too (progress).
export async function screenAll(lib: string, pmids: string[], prompt: string, topic: string, paper: (pmid: string) => string | null, ask: Ask, model: string, parallel: number, note: (r: ScreenResult, ms: number) => void = () => {}, done: (r: ScreenResult) => void = () => {}): Promise<ScreenResult[]> {
  const dir = join(lib, "screen", cacheKey(model, prompt, topic));
  const out: ScreenResult[] = new Array(pmids.length);
  let next = 0;
  const worker = async () => {
    while (next < pmids.length) {
      const i = next++; const pmid = pmids[i];
      const file = join(dir, `${pmid}.json`);
      if (existsSync(file)) {
        try {
          const c = JSON.parse(readFileSync(file, "utf8"));
          out[i] = c?.refused === true ? { pmid, refused: true, cached: true } : { pmid, screened: c as Screened, cached: true };
          done(out[i]); continue;
        } catch { /* half a file is no file */ }
      }
      const text = paper(pmid);
      if (!text) { out[i] = { pmid, error: "no abstract", cached: false }; note(out[i], 0); done(out[i]); continue; }
      const t = Date.now();
      try {
        const s = await ask(fill(prompt, topic, text));
        mkdirSync(dirname(file), { recursive: true }); writeAtomic(file, JSON.stringify(s) + "\n");
        out[i] = { pmid, screened: s, cached: false };
      } catch (e) {
        if (e instanceof Refusal) { mkdirSync(dirname(file), { recursive: true }); writeAtomic(file, '{"refused":true}\n'); out[i] = { pmid, refused: true, cached: false }; }
        else out[i] = { pmid, error: e instanceof Error ? e.message : String(e), cached: false };
      }
      note(out[i], Date.now() - t); done(out[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, pmids.length) }, worker));
  return out;
}

// The score (concept: Score): off-topic out; evidence level first, then within a level
// relevance, hard outcomes, size and how many queries found the paper. finding is not
// in the score: ranking positive results higher builds in publication bias.
const LEVELS: [RegExp, number][] = [[/meta-analy|systematic review/i, 50], [/\b(rct|randomi[sz]ed)/i, 40], [/cohort|prospective|registry/i, 30], [/case-control|cross-sectional/i, 20], [/guideline|consensus/i, 35]];
// citesPerYear: OpenAlex's citations per year since publication (src/citecount.ts), 0 when
// unknown. Animal and in vitro studies count as level 25, between a case-control study
// and a cohort: a topic with little human evidence rests on them (bench 2026-11-19).
// inReviews: how many of the map's top reviews include the article (backward citation searching).
export function score(s: Screened, types: string | null, queries: number, citesPerYear = 0, inReviews = 0): number {
  if (s.relevance === "off-topic") return 0;
  const text = `${types ?? ""} ${s.design}`;
  const level = s.population === "animals" || s.population === "in vitro" ? 25 : LEVELS.reduce((m, [re, v]) => (re.test(text) ? Math.max(m, v) : m), 10);
  const rel = s.relevance === "direct" ? 30 : s.relevance === "indirect" ? 15 : 0;
  const hard = s.outcome === "hard" ? 10 : 0;
  const size = s.n && s.n > 0 ? Math.min(15, Math.round(3 * Math.log10(s.n))) : 0;
  return Math.round(level + rel + hard + size + Math.min(10, 2 * queries) + 20 * Math.log10(1 + citesPerYear) + 4 * Math.log2(1 + inReviews));
}

// An article without an abstract that the screening called off-topic from its title alone: not
// trusted (a risk case report was lost this way, #101). It stays in, scored by what is known
// without the screening — publication types, queries, citations, reviews — so an aspect can be offered it.
export function scoreTitleOnly(types: string | null, queries: number, citesPerYear = 0, inReviews = 0): number {
  const level = LEVELS.reduce((m, [re, v]) => (re.test(types ?? "") ? Math.max(m, v) : m), 10);
  return Math.round(level + Math.min(10, 2 * queries) + 20 * Math.log10(1 + citesPerYear) + 4 * Math.log2(1 + inReviews));
}

// The log line for one screening call: the answer's fields in a row, or the failure.
export function screenLine(r: ScreenResult, ms: number, model: string): string {
  // the step, then its time, as the other tools log it ("screened 01.3s direct · …")
  const secs = `${(ms / 1000).toFixed(1).padStart(4, "0")}s`;
  if (r.refused) return `refused ${secs} · ${model}`;
  if (!r.screened) return `screen failed ${secs} · ${model} · ${r.error}`;
  const f = r.screened;
  return `screened ${secs} ${f.relevance} · ${f.population} · ${f.design} · n=${f.n ?? "-"} · ${f.outcome} · ${f.finding} · ${f.aspect} · ${model} · ${f.reason}`;
}
