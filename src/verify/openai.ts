import type { Answers } from "./decider.js";
import type { Provider } from "./providers.js";

// OpenAI's Decisions API (`POST {base_url}/v1/decisions`, key as a bearer
// token): gpt-6-luna, the only model it serves (November 2026). Its own wire
// format: the state goes as one user message whose `input_json` part carries
// the object ({paper, statement}) as it is, or as a plain string; questions
// are a list with a `name` and type `predicate` (our `noul`); answers come
// back as a list of {type, name, probability}, or {type: "refusal", name},
// which is an error here — a refusal must not read as "the paper does not
// state it".
export const openai: Provider = {
  name: "openai",
  defaultModel: "gpt-6-luna",
  hostedUrl: "https://api.openai.com",
  keyPrefixes: ["sk-"],
  modelPrefix: "gpt-",
  matches: (host) => host === "api.openai.com",
  windowChars: () => 400000,   // its context limit for decisions is not documented: half of the others', a longer paper is windowed
  request: ({ base_url, api_key, model, state, questions }) => ({
    url: `${base_url}/v1/decisions`,
    headers: { "content-type": "application/json", ...(api_key ? { authorization: `Bearer ${api_key}` } : {}) },
    body: JSON.stringify({
      model,
      input: typeof state === "string" ? state : [{ role: "user", content: [{ type: "input_json", data: state }] }],
      questions: Object.entries(questions).map(([name, q]) => ({ type: "predicate", name, instructions: q.instructions })),
    }),
  }),
  parse: (body) => {
    const list = (body as { answers?: { type?: string; name?: string; probability?: number }[] }).answers;
    if (!Array.isArray(list)) return null;
    const out: Answers = {};
    for (const a of list) {
      if (a.type === "refusal") throw new Error(`refused to answer "${a.name}"`);
      if (a.name && typeof a.probability === "number") out[a.name] = { noul: a.probability };
    }
    return out;
  },
};
