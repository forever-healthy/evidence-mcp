import { coreTier } from "./core.js";
import { doilink } from "./doilink.js";
import { europepmc } from "./europepmc.js";
import { openalex } from "./openalex.js";
import { pmc } from "./pmc.js";
import { tdmTier, type TdmTokens } from "./tdm.js";
import type { Tier } from "./tier.js";
import { unpaywall } from "./unpaywall.js";

// Registry of built-in tiers, in default order (src/config.ts: FH_TIERS
// selects and orders them); tdm takes its tokens, core its key, both from the
// environment. The contact email is global (FH_CONTACT_EMAIL).
export type TierOptions = { tokens?: TdmTokens; api_key?: string };

export const BUILTIN: { name: string; make: (o: TierOptions) => Tier }[] = [
  { name: "pmc", make: () => pmc },
  { name: "europepmc", make: () => europepmc },
  { name: "tdm", make: (o) => tdmTier(o.tokens ?? {}) },
  { name: "unpaywall", make: () => unpaywall },
  { name: "openalex", make: () => openalex },
  { name: "core", make: (o) => coreTier(o.api_key) },
  { name: "doi-link", make: () => doilink },
];
