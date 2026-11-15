import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Loads .env into process.env before anything reads it: the --env <file> argument
// names the file, or FH_ENV in the environment (never in the file it names); else
// .env in the working directory (the consumer's project
// root — where AI4L keeps its tokens too); else .env in the library directory
// (a fleet of review workers keeps its values there; the library directory itself
// then comes from the environment).
// Variables already set in the environment win. KEY=value lines, optional
// quotes, # comments; nothing else.

// --env <file> (or --env=<file>) in the server's arguments names the file — the
// documented way, visible in the MCP configuration (2026-11-13); FH_ENV in the
// environment does the same for setups that set it there (containers).
export function argEnv(argv: string[] = process.argv): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env" && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith("--env=")) return argv[i].slice(6) || null;
  }
  return null;
}

export function dotenvFile(env = process.env, argv: string[] = process.argv): string {
  const named = argEnv(argv)?.trim() || env.FH_ENV?.trim();
  if (named) return resolve(named);
  if (existsSync(resolve(".env"))) return resolve(".env");
  const lib = env.FH_EVIDENCE_DIR?.trim() || (existsSync("/evidence") ? "/evidence" : "evidence");   // as src/layout.ts resolves it
  return join(resolve(lib), ".env");
}

// The names the .env file set (the environment had them unset): fh_info
// reports per value whether it came from the environment, the file or the default.
export const loadedFromDotenv = new Set<string>();

export function loadDotenv(file = dotenvFile()): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (process.env[m[1]] === undefined) { process.env[m[1]] = v; loaded.push(m[1]); loadedFromDotenv.add(m[1]); }
  }
  return loaded;
}

// The whole configuration is the environment: every value an FH_*
// variable (the keys other servers read by the same name stay bare:
// FH_NCBI_API_KEY, FH_BRIGHTDATA_API_KEY, FH_BRIGHTDATA_ZONE), the structure and the
// defaults code. Precedence: environment, then the .env file, then the default.
export type Source = "environment" | ".env" | "default";
export function sourceOf(name: string, env: NodeJS.ProcessEnv = process.env): Source {
  if (!env[name]?.trim()) return "default";
  return loadedFromDotenv.has(name) ? ".env" : "environment";
}
export const str = (name: string, env: NodeJS.ProcessEnv = process.env): string => env[name]?.trim() ?? "";
export function num(name: string, def: number, env: NodeJS.ProcessEnv = process.env, ok: (n: number) => boolean = (n) => n >= 0): number {
  const v = str(name, env);
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && ok(n) ? n : def;
}
export function bool(name: string, def: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = str(name, env).toLowerCase();
  return ["true", "1", "yes", "on"].includes(v) ? true : ["false", "0", "no", "off"].includes(v) ? false : def;
}
