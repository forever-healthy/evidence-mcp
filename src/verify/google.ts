import type { Provider } from "./providers.js";

// Google Gemini Decision through the Gemini Decisions API (the current model
// gemini-decision-1, launched 2026-11-11; `POST {base_url}/v1beta/decisions`,
// key in x-goog-api-key, from Google AI Studio). Same questions, same answers as Perplexity's; the state
// goes as `input`: a string as is, an object as one text block per field,
// each a one-key JSON object, so the question's "paper" and "statement" name
// what the model sees. 262,144 tokens per request, input and questions
// together. On the free tier Google may use what is sent to improve its
// products; on the paid tier it does not.
export const google: Provider = {
  name: "google",
  defaultModel: "gemini-decision-1",
  hostedUrl: "https://generativelanguage.googleapis.com",
  keyPrefixes: ["AIza", "AQ."],   // AQ.: the newer AI Studio keys
  modelPrefix: "gemini-",
  matches: (host) => host === "generativelanguage.googleapis.com",
  windowChars: () => 800000,
  request: ({ base_url, api_key, model, state, questions }) => ({
    url: `${base_url}/v1beta/decisions`,
    headers: { "content-type": "application/json", ...(api_key ? { "x-goog-api-key": api_key } : {}) },
    body: JSON.stringify({ model, input: googleInput(state), questions }),
  }),
};

export function googleInput(state: unknown): unknown {
  if (typeof state === "string") return state;
  if (!state || typeof state !== "object") return JSON.stringify(state);
  return Object.entries(state as Record<string, unknown>).map(([k, v]) => ({ type: "text", text: JSON.stringify({ [k]: v }) + "\n" }));
}
