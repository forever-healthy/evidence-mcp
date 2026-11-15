import { str } from "./env.js";

// The one contact address every tier sends along: NCBI E-utilities
// (tool/email), Unpaywall and OpenAlex polite pools, Crossref mailto, and the
// User-Agent. FH_CONTACT_EMAIL, else the project's address. Read
// from src/env.ts directly so src/http.ts can use it at load without an import
// cycle through the tiers.

const DEFAULT = "hello@forever-healthy.org";

export const contactEmail = (env: NodeJS.ProcessEnv = process.env): string => str("FH_CONTACT_EMAIL", env) || DEFAULT;
