import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { entryExists, readMeta, writeMeta } from "./entry.js";
import { entryPaths } from "./layout.js";
import { activePrompt } from "./prompts.js";
import { CHARACTERISTICS, screenConfig, SCREEN_PROVIDERS, SCREEN_TIMEOUT_MS } from "./screen.js";

// Study characteristics: what kind of study an article is — its design, its participants, its population. They are
// the same for every topic, so they are stored with the article in the library (its meta: design, participants,
// population, characteristics_by) and returned with its metadata. Two ways in:
//   - an evidence map's screening reads them in its one call per article and hands them over (src/evidencemap.ts);
//   - fh_library_add asks the screening model with the small prompt evmap/characteristics.md, when one is
//     configured — after it answered, not making the add wait.
// An article that has them keeps them: both ask the same question with the same definitions (CHARACTERISTICS, src/screen.ts).

const SCHEMA = { type: "object", properties: CHARACTERISTICS, required: ["population", "design", "n"], additionalProperties: false } as const;
export type Characteristics = { design?: string | null; n?: number | null; population?: string | null };

// Stores an article's characteristics, if the article is in the library and has none yet. true: stored now.
export function storeCharacteristics(libraryDir: string, pmid: string, c: Characteristics, by: string): boolean {
  const design = c.design?.replace(/\s+/g, " ").trim();
  if (!design) return false;
  const p = entryPaths(libraryDir, "pmid", pmid);
  if (!entryExists(p) || !existsSync(p.meta)) return false;
  const m = readMeta(p);
  if (m.design) return false;
  writeMeta(p, { ...m, design, participants: typeof c.n === "number" && c.n > 0 ? c.n : null, population: c.population && c.population !== "none" ? c.population : null, characteristics_by: by });
  return true;
}

export type AskCharacteristics = (prompt: string) => Promise<Characteristics>;
// The screening model's call for the small prompt; null: no screening model is configured.
export function characteristicsAsk(env: NodeJS.ProcessEnv = process.env): { ask: AskCharacteristics; model: string } | null {
  const c = screenConfig(env);
  if (!c.ok) return null;
  if (c.api === "anthropic") {
    const client = new Anthropic({ apiKey: c.key, baseURL: c.url, maxRetries: 3, timeout: SCREEN_TIMEOUT_MS });
    return { model: c.model, ask: async (text) => {
      const r = await client.messages.create({ model: c.model, max_tokens: 512, output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } }, messages: [{ role: "user", content: text }] } as Anthropic.MessageCreateParamsNonStreaming);
      const block = r.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      if (!block) throw new Error("no answer");
      return JSON.parse(block.text) as Characteristics;
    } };
  }
  const extra = (SCREEN_PROVIDERS[c.provider] as { body?: Record<string, unknown> }).body ?? {};
  return { model: c.model, ask: async (text) => {
    const r = await fetch(`${c.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) }, body: JSON.stringify({ ...extra, model: c.model, messages: [{ role: "user", content: text }], response_format: { type: "json_schema", json_schema: { name: "characteristics", strict: true, schema: SCHEMA } } }), signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const content = ((await r.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("no answer");
    return JSON.parse(content) as Characteristics;
  } };
}

// An article just added: its characteristics read from the abstract and stored. Never throws; the outcome is for the log.
export async function extractCharacteristics(libraryDir: string, pmid: string, article: string, env: NodeJS.ProcessEnv = process.env, asker: { ask: AskCharacteristics; model: string } | null = characteristicsAsk(env)): Promise<string | null> {
  if (!asker) return null;   // no model: the article is stored without them
  try {
    const prompt = activePrompt("characteristics", env);
    const c = await asker.ask(prompt.text.split("{{article}}").join(article));
    return storeCharacteristics(libraryDir, pmid, c, asker.model) ? `characteristics ${c.design} · n=${c.n ?? "-"} · ${c.population ?? "-"} · ${asker.model}` : null;
  } catch (e) { return `characteristics failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`; }
}
