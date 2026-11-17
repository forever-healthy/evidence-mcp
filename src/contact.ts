import { str } from "./env.js";

// The one contact address every tier sends along: NCBI E-utilities
// (tool/email), Unpaywall and OpenAlex polite pools, Crossref mailto, and the
// User-Agent. FH_CONTACT_EMAIL, else the project's address. Read
// from src/env.ts directly so src/http.ts can use it at load without an import
// cycle through the tiers.

const DEFAULT = "hello@forever-healthy.org";

export const contactEmail = (env: NodeJS.ProcessEnv = process.env): string => str("FH_CONTACT_EMAIL", env) || DEFAULT;

// OpenAlex: the contact as mailto, and the key when one is set (FH_OPENALEX_API_KEY,
// optional): without one, single records and page= paging; with one, cursor= paging
// and a daily allowance ($1 a day free, a list request $0.0001; 2026-11-16).
export const openalexParams = (env: NodeJS.ProcessEnv = process.env): string => {
  const key = env.FH_OPENALEX_API_KEY?.trim();
  return `mailto=${encodeURIComponent(contactEmail(env))}${key ? `&api_key=${encodeURIComponent(key)}` : ""}`;
};
