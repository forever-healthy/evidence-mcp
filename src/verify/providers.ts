import { google } from "./google.js";
import { openai } from "./openai.js";
import { perplexity } from "./perplexity.js";

// A decision-model provider: how one Decisions API request is addressed and
// shaped, and how its answer is read. Inside the server the questions and
// answers have one shape ({key: {type: "noul", instructions}} out,
// {key: {noul}} back); a provider maps its own wire format to that — the path,
// how the key is sent, how the state is put, and (parse) answers that come
// back in another shape. A new provider is one file like perplexity.ts and one
// entry below.

import type { Answers, Decisions } from "./decider.js";

export type Request = { url: string; headers: Record<string, string>; body: string };

export type Provider = {
  name: string;
  defaultModel: string;
  hostedUrl: string;                                  // used when only the key is set
  keyPrefixes: string[];                              // how the provider's API keys begin
  modelPrefix: string;                                // how its model names begin
  matches: (host: string) => boolean;                 // FH_VERIFY_URL's host
  windowChars: (baseUrl: string, model: string) => number;   // the longest text sent in one request
  request: (r: { base_url: string; api_key: string | null; model: string; state: unknown; questions: Decisions }) => Request;
  // The answers out of the response body, in the server's shape; null when the
  // body holds none (an error then). Default: body.answers as it is.
  parse?: (body: unknown) => Answers | null;
};

// In order; the last one takes every URL the others do not claim (a local
// Decider for Mac has no host name of its own).
const PROVIDERS: Provider[] = [google, openai, perplexity];

export const PROVIDER_NAMES = PROVIDERS.map((p) => p.name);
export const providerByName = (name: string): Provider | null => PROVIDERS.find((p) => p.name === name) ?? null;

// A key alone names its provider (pplx-…; AIza… or AQ.…; sk-…): hosted, no URL needed.
export const providerForKey = (key: string): Provider | null => PROVIDERS.find((p) => p.keyPrefixes.some((k) => key.startsWith(k))) ?? null;

export function providerFor(baseUrl: string): Provider {
  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { /* not a URL: the fallback */ }
  return PROVIDERS.find((p) => p.matches(host)) ?? PROVIDERS[PROVIDERS.length - 1];
}
