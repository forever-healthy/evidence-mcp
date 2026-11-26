import { activePrompt } from "./prompts.js";
import Anthropic from "@anthropic-ai/sdk";
import { num, str } from "./env.js";
import { describe, SCREEN_PROVIDERS, screenConfig, ScreenError, type ScreenConfig, type ScreenProvider, where } from "./screen.js";
import { poolKeys } from "./keypool.js";

// The models of the evidence map's discovery and ranking steps: their settings and the call that answers in JSON.
// The picks per aspect: src/items.ts.
export const RANK_TIMEOUT_MS = 180_000;

// The ranking's own settings, like the screening's: FH_EVMAP_RANKING_PROVIDER (default: the screening's),
// _API_KEY, _URL, _MODEL. Key and URL, each: the RANK variable, else the provider's section
// (FH_EVMAP_<PROVIDER>_API_KEY / _URL), else — the same provider as the screening — the plain
// FH_EVMAP_SCREENING_API_KEY / _URL. The model: FH_EVMAP_RANKING_MODEL, else the provider's ranking default.
export type RankConfig = { ok: true; config: Extract<ScreenConfig, { ok: true }>; model: string } | { ok: false; problem: string };
// The settings of the discovery model (src/discovery.ts: it writes the queries) and of the ranking
// model: FH_EVMAP_<PART>_PROVIDER and _MODEL, both named — no default model, no provider taken
// from another part: whoever sets the map up chooses its three models. Only the key (and the
// URL) may be shared: the part's own, else the provider's section (FH_EVMAP_<PROVIDER>_API_KEY),
// else the key of another part that names the same provider.
export function rankConfig(env: NodeJS.ProcessEnv = process.env, part: "RANKING" | "DISCOVERY" = "RANKING"): RankConfig {
  const what = part === "RANKING" ? "ranking" : "discovery";
  const p = str(`FH_EVMAP_${part}_PROVIDER`, env).toLowerCase() as ScreenProvider;
  if (!p) return { ok: false, problem: `FH_EVMAP_${part}_PROVIDER: not set — the ${what} model's provider (${Object.keys(SCREEN_PROVIDERS).join(", ")})` };
  if (!(p in SCREEN_PROVIDERS)) return { ok: false, problem: `FH_EVMAP_${part}_PROVIDER: ${p}, not one of ${Object.keys(SCREEN_PROVIDERS).join(", ")}` };
  const model = str(`FH_EVMAP_${part}_MODEL`, env);
  if (!model) return { ok: false, problem: `FH_EVMAP_${part}_MODEL: not set — the ${what} model for ${p}, a strong one` };
  const others = (["DISCOVERY", "SCREENING", "RANKING"] as const).filter((o) => o !== part && str(`FH_EVMAP_${o}_PROVIDER`, env).toLowerCase() === p);
  const pick = (f: "API_KEY" | "URL"): [string, string] => {
    for (const v of [`FH_EVMAP_${part}_${f}`, `FH_EVMAP_${p.toUpperCase()}_${f}`, ...others.map((o) => `FH_EVMAP_${o}_${f}`)]) if (str(v, env)) return [str(v, env), v];
    return ["", `FH_EVMAP_${part}_${f}`];
  };
  const [key, keyVar] = pick("API_KEY"); const [url, urlVar] = pick("URL");
  if (!key && !url) return { ok: false, problem: `FH_EVMAP_${part}_API_KEY: no key for the ${what} model's provider ${p} (or FH_EVMAP_${p.toUpperCase()}_API_KEY, or another part's key for ${p})` };
  const P = SCREEN_PROVIDERS[p];
  return { ok: true, config: { ok: true as const, provider: p, api: P.api, url: url.replace(/\/+$/, "") || P.url, model, key, vars: { key: keyVar, model: `FH_EVMAP_${part}_MODEL`, url: urlVar } }, model };
}

// One question to a strong model, the answer in a fixed form (a JSON schema): for the discovery's
// steps (src/discovery.ts). Anthropic's API or an OpenAI-compatible one, as the ranking.
export async function askJson(c: Extract<ScreenConfig, { ok: true }>, model: string, prompt: string, schema: object, name: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const at = where({ ...c, model });
  try {
    let text: unknown;
    if (c.api === "anthropic") {
      const client = new Anthropic({ apiKey: c.key, baseURL: c.url, maxRetries: 2, timeout: RANK_TIMEOUT_MS });
      const r = await client.messages.create({ model, max_tokens: 32000, output_config: { format: { type: "json_schema", schema } }, messages: [{ role: "user", content: prompt }] } as Anthropic.MessageCreateParamsNonStreaming);
      if (r.stop_reason === "refusal") throw new Error("refusal");
      if (r.stop_reason === "max_tokens") throw new Error("the answer was cut off at its maximum length");
      text = r.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    } else {
      const r = await fetchImpl(`${c.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_schema", json_schema: { name, strict: true, schema } } }),
        signal: AbortSignal.timeout(RANK_TIMEOUT_MS),
      });
      if (!r.ok) throw new ScreenError(`HTTP ${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 2000)}`, r.status);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await r.json();
      text = body?.choices?.[0]?.message?.content;
    }
    if (typeof text !== "string") throw new Error("no answer");
    try { return JSON.parse(text); } catch { throw new Error(`the answer is not JSON: ${text.slice(0, 80)}`); }
  } catch (e) { throw new Error(describe(e, at, { key: c.vars?.key ?? "FH_EVMAP_DISCOVERY_API_KEY", model: "FH_EVMAP_DISCOVERY_MODEL", url: c.vars?.url ?? "FH_EVMAP_DISCOVERY_URL" })); }
}

// The evidence map's models as configured, and what is wrong with the settings — at startup (a
// "!!" line) and in fh_info, like the decision model's. Only when the evidence map is on.
type PartModel = { provider: string; model: string; url: string } | null;   // null: not usable, the reason among the problems
export type EvmapModels = { discovery: PartModel; screening: PartModel; screening_pool_keys?: number; ranking: PartModel; prompts: { discovery: string; screening: string; ranking: string } };
export function evmapModels(env: NodeJS.ProcessEnv = process.env): { models: EvmapModels; problems: string[] } {
  const problems: string[] = [];
  const s = screenConfig(env);
  if (!s.ok) problems.push(`evidence map screening: ${s.reason} — fh_evmap_create_map will refuse to run`);
  if (s.ok) {
    const k = s.key;
    const looks = k.startsWith("sk-ant-") ? "anthropic" : k.startsWith("sk-or-") ? "openrouter" : k.startsWith("xai-") ? "xai" : k.startsWith("AIza") || k.startsWith("AQ.") ? "google" : k.startsWith("sk-") ? "openai" : null;
    if (looks && looks !== s.provider) problems.push(`evidence map screening: the key for ${s.provider} looks like a ${looks} key (FH_EVMAP_${s.provider.toUpperCase()}_API_KEY or FH_EVMAP_SCREENING_API_KEY)`);
  }
  const part = (name: "DISCOVERY" | "RANKING"): PartModel => {
    const r = rankConfig(env, name);
    if (r.ok) return { provider: r.config.provider, model: r.model, url: r.config.url };
    // the discovery is in development (the tool does not use it yet): its missing settings do not stop the map
    problems.push(`evidence map ${name.toLowerCase()}: ${r.problem}${name === "RANKING" ? " — fh_evmap_create_map will refuse to run" : ""}`);
    return null;
  };
  const discovery = part("DISCOVERY"), ranking = part("RANKING");
  // the prompts in force: a project's file or the built-in one; a file that cannot be used is a problem
  const pd = activePrompt("discovery", env), ps = activePrompt("screening", env), pr = activePrompt("ranking", env);
  for (const x of [pd, ps, pr]) if (x.problem && !problems.some((p) => p.includes(x.problem!))) problems.push(`evidence map prompts: ${x.problem} — fh_evmap_create_map will refuse to run`);
  const pool = poolKeys(env).length;   // the screening's key pool (src/keypool.ts)
  return { models: { discovery, screening: s.ok ? { provider: s.provider, model: s.model, url: s.url } : null, ...(pool ? { screening_pool_keys: pool } : {}), ranking, prompts: { discovery: pd.source, screening: ps.source, ranking: pr.source } }, problems };
}
