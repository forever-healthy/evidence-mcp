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
  // Hosted takes 256k tokens in one request (a 50k-token paper in 2 s); the
  // Mac app is limited to 32k and slows steeply beyond 25k, so it windows.
  windowChars: (baseUrl) => { try { return new URL(baseUrl).hostname === "api.perplexity.ai" ? 800000 : 90000; } catch { return 90000; } },
  request: ({ base_url, api_key, model, state, questions }) => ({
    url: `${base_url}/v1/decisions`,
    headers: { "content-type": "application/json", ...(api_key ? { authorization: `Bearer ${api_key}` } : {}) },
    body: JSON.stringify({ model, state, questions }),
  }),
};
