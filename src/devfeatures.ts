import { dataciteEnabled } from "./datacite.js";
import { evidEnabled } from "./evid.js";
import { evidenceMapEnabled } from "./evidencemap.js";

// The development-only features this server offers, for one startup line each:
// they are hidden from fh_info and .env.example while off, so the log says which
// are on: the switch's name.
export function devFeatures(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (evidEnabled(env)) out.push("FH_EVID_ENABLED");
  if (evidenceMapEnabled(env)) out.push("FH_EVMAP_ENABLED");
  if (dataciteEnabled(env)) out.push("FH_DATACITE_ENABLED");
  return out;
}
