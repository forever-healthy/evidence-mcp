import { num, str } from "../env.js";
import { PROVIDER_NAMES, providerByName, providerFor, providerForKey, type Provider } from "./providers.js";

// fh_verify_claim's decision model, as documented (.env.example, README):
//   FH_VERIFY_PROVIDER  perplexity | google | openai | liquid — the API the server speaks
//   FH_VERIFY_URL       empty: the provider's hosted endpoint
//   FH_VERIFY_MODEL     empty: the provider's default
//   FH_VERIFY_API_KEY   empty for a key-less server (Decider for Mac)
//   FH_VERIFY_THRESHOLD (0.5), FH_VERIFY_TIMEOUT_SECS (60)
// Neither URL nor key: verification is off.
//
// Sections, for development (not in the public docs): FH_VERIFY_<PROVIDER>_URL,
// _MODEL, _API_KEY, one set per provider, so several keys sit in one .env and a
// switch is one word (stuff/verify compares every filled section). A section's
// field wins over the plain variable; the plain one fills what it leaves empty.

export type VerifyConfig = {
  provider: Provider;
  base_url: string;              // FH_VERIFY_<PROVIDER>_URL: "https://api.perplexity.ai", "http://<ip>:8080" (Decider for Mac), "https://generativelanguage.googleapis.com"
  api_key: string | null;        // FH_VERIFY_<PROVIDER>_API_KEY: hosted needs one; local: none
  model: string;                 // FH_VERIFY_<PROVIDER>_MODEL, else the provider's default
  threshold: number;             // P(true) at or above which the paper backs the claim
  window_chars: number;          // a paper longer than this is judged in windows cut at headings
  timeout_seconds: number;       // per model request; over it the call answers error and the log says so
};

// As forgiving as it can be, so a slip in the .env does not stop verification,
// and what cannot be fixed is said (verifyProblems: at startup and in fh_info):
// - no FH_VERIFY_PROVIDER: the one section that is filled in; with only the
//   plain variables (setups from before the switch), the key's prefix
//   (pplx-…; AIza… or AQ.…), else the URL's host, else perplexity;
// - a URL pasted with its path (/v1, /v1beta, …/decisions) is cut back to the host;
// - a model of another provider (left over from a switch) gives way to this one's default.
type Resolved = { cfg: VerifyConfig | null; problems: string[] };
type Field = "MODEL" | "URL" | "API_KEY";
const cleanUrl = (u: string) => u.replace(/\/+$/, "").replace(/\/(v1beta|v1)(\/decisions)?$|\/decisions$/, "");
function resolve(env: NodeJS.ProcessEnv): Resolved {
  const problems: string[] = [];
  // A field of one provider's section, else the plain variable; with the name it came from.
  const field = (p: Provider | null, f: Field): [string, string] => {
    const own = p ? `FH_VERIFY_${p.name.toUpperCase()}_${f}` : "";
    if (own && str(own, env)) return [str(own, env), own];
    const plain = str(`FH_VERIFY_${f}`, env);
    return [plain, plain || !own ? `FH_VERIFY_${f}` : own];   // both empty: named after the section
  };
  const filled = (p: Provider) => !!(str(`FH_VERIFY_${p.name.toUpperCase()}_URL`, env) || str(`FH_VERIFY_${p.name.toUpperCase()}_API_KEY`, env));
  const name = str("FH_VERIFY_PROVIDER", env).toLowerCase();
  let provider: Provider | null = null;
  if (name) {
    provider = providerByName(name);
    if (!provider) return { cfg: null, problems: [`FH_VERIFY_PROVIDER: unknown provider "${name}" (built-in: ${PROVIDER_NAMES.join(", ")}): verification is off`] };
  } else {
    const sections = PROVIDER_NAMES.map((n) => providerByName(n)!).filter(filled);
    if (sections.length > 1) return { cfg: null, problems: [`FH_VERIFY_PROVIDER is not set and several sections are filled in (${sections.map((p) => p.name).join(", ")}): verification is off — name one`] };
    provider = sections[0] ?? null;
  }
  const [key, keyVar] = field(provider, "API_KEY");
  const [url, urlVar] = field(provider, "URL");
  const api_key = key || null;
  let base_url = cleanUrl(url);
  if (!base_url && !api_key) {
    if (provider) problems.push(`FH_VERIFY_PROVIDER=${provider.name}, but neither ${urlVar} nor ${keyVar} is set: verification is off`);
    return { cfg: null, problems };
  }
  if (!provider) provider = (api_key ? providerForKey(api_key) : null) ?? providerFor(base_url);
  const keyOf = api_key ? providerForKey(api_key) : null;
  if (keyOf && keyOf !== provider) problems.push(`${keyVar} looks like a ${keyOf.name} key, but the provider is ${provider.name}`);
  if (!base_url) base_url = provider.hostedUrl;
  if (!api_key && provider.matches(new URL(base_url).hostname)) problems.push(`${provider.name}'s hosted endpoint needs a key, and ${keyVar} is empty`);
  const [m, modelVar] = field(provider, "MODEL");
  const model = m && m.startsWith(provider.modelPrefix) ? m : provider.defaultModel;
  if (m && !m.startsWith(provider.modelPrefix)) problems.push(`${modelVar}=${m} is not a ${provider.name} model: ${provider.defaultModel} is used`);
  return {
    problems,
    cfg: {
      provider, base_url, api_key,
      model,
      threshold: num("FH_VERIFY_THRESHOLD", 0.5, env, (n) => n > 0 && n < 1),
      window_chars: provider.windowChars(base_url, model),
      timeout_seconds: num("FH_VERIFY_TIMEOUT_SECS", 60, env, (n) => n > 0),
    },
  };
}

export const verifyConfig = (env: NodeJS.ProcessEnv = process.env): VerifyConfig | null => resolve(env).cfg;
export const verifyProblems = (env: NodeJS.ProcessEnv = process.env): string[] => resolve(env).problems;

// Paper text leaves the machine when the endpoint is not local: loopback,
// RFC 1918 or the Tailscale range (100.64/10) count as local.
export function isLocal(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname;
    return h === "localhost" || /^127\./.test(h) || h === "::1" || /^10\./.test(h) || /^192\.168\./.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
  } catch { return false; }
}
