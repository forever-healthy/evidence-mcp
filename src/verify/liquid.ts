import type { Provider } from "./providers.js";

// Liquid AI's decision models through the Liquid API (`POST
// {base_url}/decisions/v1/systemone`, key as a bearer token), TypeSafe's
// System One API — Perplexity's Decisions API in all but the path: the state
// as JSON ({paper, statement}), {key: {type: "noul", instructions}} questions,
// {key: {type: "noul", noul}} answers, so the default parse reads them.
// Hosted at api.liquid.ai: d1-ultra (the default: the most capable, 32,768 tokens
// in one request) and d1.1 (cheaper and faster, 65,536); both at most 250 KB of text
// (docs.liquid.ai/api/reference/decision-models/make-decisions, 2026-11-15).
// Its keys begin liquid_, so a key alone names it.
//
// Locally: d1-2B (open weights, 128k tokens) served by llama.cpp,
// `llama serve -hf LiquidAI/d1-2B-GGUF:Q8_0 -b 8192 -ub 8192`, answers the same
// API at /v1/systemone (port 9931), without a key — FH_VERIFY_PROVIDER=liquid,
// FH_VERIFY_LIQUID_URL=http://<host>:9931. A question is read in one batch, so
// -b and -ub must hold the paper: 8192 tokens is ~24,000 characters, a full
// text needs 32768 (docs.liquid.ai/lfm/models/d1-2b, 2026-11-16).
const hosted = (baseUrl: string) => { try { return new URL(baseUrl).hostname === "api.liquid.ai"; } catch { return false; } };

export const liquid: Provider = {
  name: "liquid",
  // d1-ultra (2026-11-16, claims.json, 3 rounds): 22/22, true claims ≥ 0.95, false ≤ 0.05, 1.7 s median;
  // d1.1 22/22 too but with less margin (≥ 0.89, ≤ 0.12), 0.5 s
  defaultModel: "d1-ultra",
  hostedUrl: "https://api.liquid.ai",
  keyPrefixes: ["liquid_"],
  modelPrefix: "d1",
  matches: (host) => host === "api.liquid.ai",
  // Characters per window for the model's tokens, with room for the statement and
  // the question. A paper's Markdown can run under 2.75 characters a token
  // (2026-11-16: a 90,000-character window of pmid:18843650 went over d1-ultra's
  // 32,768), so 75,000 for 32k (d1-ultra; local, for -b/-ub 32768) and 150,000
  // for d1.1's 65k — both under the 250 KB text limit.
  windowChars: (baseUrl, model) => (!hosted(baseUrl) || /^d1-ultra/.test(model) ? 75000 : 150000),
  request: ({ base_url, api_key, model, state, questions }) => ({
    url: `${base_url}${hosted(base_url) ? "/decisions" : ""}/v1/systemone`,   // the Liquid API under /decisions, llama.cpp at the root
    headers: { "content-type": "application/json", ...(api_key ? { authorization: `Bearer ${api_key}` } : {}) },
    body: JSON.stringify({ model, state, questions }),
  }),
};
