import type { Provider } from "./providers.js";

// Perplexity's Decider through the Perplexity Decisions API (`POST
// {base_url}/v1/decisions`, key as a bearer token): hosted at
// api.perplexity.ai (pplx-decider-v1.2, 27B), or the Decider for Mac app on a
// machine of your own (pplx-decider-flash-v1.2, the only model it serves; no
// key; the paper stays local). The state goes as JSON, {paper, statement}.
export const perplexity: Provider = {
  name: "perplexity",
  defaultModel: "pplx-decider-flash-v1.2",
  hostedUrl: "https://api.perplexity.ai",
  keyPrefixes: ["pplx-"],
  modelPrefix: "pplx-",
  matches: (host) => host === "api.perplexity.ai",
  // Hosted takes 262,144 tokens in one request (a 50k-token paper in 2 s); the
  // Mac app is limited to 32k and slows steeply beyond 25k, so it windows.
  // Hosted windows of 400,000 characters: a paper's Markdown ran as dense as 1.7
  // characters a token (tables, numbers) — 800,000-character windows went over
  // the limit, 367 claims on live 2026-11-11–16 ("requires 470509 tokens").
  windowChars: (baseUrl) => { try { return new URL(baseUrl).hostname === "api.perplexity.ai" ? 400000 : 90000; } catch { return 90000; } },
  request: ({ base_url, api_key, model, state, questions }) => ({
    url: `${base_url}/v1/decisions`,
    headers: { "content-type": "application/json", ...(api_key ? { authorization: `Bearer ${api_key}` } : {}) },
    body: JSON.stringify({ model, state, questions }),
  }),
};
