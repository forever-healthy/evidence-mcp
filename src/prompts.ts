import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { str } from "./env.js";
import { BUILTIN_PROMPTS } from "./prompts.generated.js";

// The evidence map's three prompts: discovery (src/discovery.ts), screening (src/screen.ts),
// ranking (src/rank.ts, src/items.ts). The built-in ones are evmap/discovery.md, screening.md and
// ranking.md, compiled in by the build (scripts/gen-prompts.mjs → src/prompts.generated.ts): the
// package starts with no file beside it, and the files are the one place to edit them.
// A project's own prompts: FH_EVMAP_PROMPTS — a folder (relative to the working directory) with
// files of exactly those three names; the three are one set. A file that is not in the folder:
// the built-in one. A folder that does not exist, or a file in it without a required slot or
// section: a configuration problem (startup log, fh_info) and no map is built until it is fixed.

export type PromptKind = "screening" | "ranking" | "discovery" | "characteristics";
const BUILTIN: Record<PromptKind, string> = { screening: promptBody(BUILTIN_PROMPTS.screening), ranking: promptBody(BUILTIN_PROMPTS.ranking), discovery: promptBody(BUILTIN_PROMPTS.discovery), characteristics: promptBody(BUILTIN_PROMPTS.characteristics) };
const FILES: Record<PromptKind, { file: string; slots: string[] }> = {
  screening: { file: "screening.md", slots: ["{{topic}}", "{{article}}"] },
  ranking: { file: "ranking.md", slots: ["## Assign", "## Items", "{{items}}", "{{articles}}", "{{groups}}"] },
  // the library's own: what kind of study an article is (src/characteristics.ts)
  characteristics: { file: "characteristics.md", slots: ["{{article}}"] },
  // the discovery prompt: one section per step (## Survey; ## Tables — which tables the map has, src/tables.ts — and one section per table's list; ## Iteration; ## Item query and ## Hints go into the steps)
  discovery: { file: "discovery.md", slots: ["## Survey", "## Tables", "## Item query", "## Iteration", "{{titles}}", "{{queries}}"] },
};
export const promptSlots = (kind: PromptKind): string[] => FILES[kind].slots;
export const promptFile = (kind: PromptKind): string => FILES[kind].file;   // its sample in evmap/ (tests)

export const builtinPrompt = (kind: PromptKind): string => BUILTIN[kind];

// What in a prompt file is for people, not for the model: front matter (--- … --- at the top),
// a header (a title and its purpose, through the first line that is only ---), HTML comments
// (<!-- … -->). The model gets the naked prompt; a file with none of these is used whole.
export function promptBody(text: string): string {
  let t = text.replace(/<!--[\s\S]*?-->[ \t]*\r?\n?/g, "");
  const fm = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(t);
  if (fm) t = t.slice(fm[0].length);
  else { const m = /^---[ \t]*\r?\n/m.exec(t); if (m) t = t.slice(m.index + m[0].length); }
  return t.replace(/^\s*\n/, "");
}

// The prompt in force and where it came from. problem: the folder or the file cannot be used —
// the text is the built-in one, but no map is built with it (the callers refuse).
export const PROMPTS_SETTING = "FH_EVMAP_PROMPTS";
export type ActivePrompt = { text: string; source: string; problem?: string };
export function activePrompt(kind: PromptKind, env: NodeJS.ProcessEnv = process.env): ActivePrompt {
  const { slots, file } = FILES[kind];
  const dir = str(PROMPTS_SETTING, env);
  const builtin = (note = "", problem?: string): ActivePrompt => ({ text: BUILTIN[kind], source: `built-in (evmap/${file})${note}`, ...(problem ? { problem } : {}) });
  if (!dir) return builtin();
  const folder = resolve(dir);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return builtin("", `${PROMPTS_SETTING}=${dir}: no such folder`);
  const full = join(folder, file);
  if (!existsSync(full)) return builtin(` — no ${file} in ${dir}`);
  const text = promptBody(readFileSync(full, "utf8"));
  const missing = slots.filter((x) => !text.includes(x));
  if (missing.length) return builtin("", `${PROMPTS_SETTING}=${dir}: ${file} needs ${missing.join(" and ")}`);
  return { text, source: join(dir, file) };
}

// A prompt file of several steps: "## Name" starts a section; the text before the first one is dropped.
export function promptSections(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = text.split(/^## +(.+?)[ \t]*$/m);
  for (let i = 1; i < parts.length; i += 2) out[parts[i].trim().toLowerCase()] = parts[i + 1].trim();
  return out;
}

// One step of a prompt: its section.
export function promptStep(text: string, step: string): string | null {
  return promptSections(text)[step] ?? null;
}
