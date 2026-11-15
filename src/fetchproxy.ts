// The fetch-proxy stage of the download: the plain fetch once more,
// through an HTTP forward proxy on another host, so the request leaves from
// that host's IP. The second stage, after the plain fetch and before the
// browsers: as fast as a fetch, and it clears what is blocked by IP alone (a
// publisher that refuses data-centre ranges). It does not clear a JavaScript
// challenge or a TLS-fingerprint wall (Cloudflare, Turnstile) — that stays
// the browsers'.
//   FH_FETCH_PROXY  host or host:port (default 8888) of an HTTP proxy that
//                   tunnels HTTPS with CONNECT. utilities/fetch-proxy/ has the
//                   container (tinyproxy), utilities/deploy.sh deploys it;
//                   published on the tailnet only, it has no auth.
import { ProxyAgent } from "undici";
import { hostPort } from "./browser.js";
import { str } from "./env.js";

export const FETCH_PROXY_PORT = 8888;
export type FetchProxy = { host: string; port: number; label: string; proxy: string };

export function fetchProxy(env: NodeJS.ProcessEnv = process.env): FetchProxy | null {
  const hp = hostPort(str("FH_FETCH_PROXY", env), FETCH_PROXY_PORT);
  return hp ? { host: hp.host, port: hp.port, label: hp.host, proxy: `http://${hp.host}:${hp.port}` } : null;
}

// Its name in the log, in failure reasons and in the wall memory: "fetch-proxy home-box".
export const fetchProxyName = (r: { label: string }) => `fetch-proxy ${r.label}`;

// One connection pool per proxy, kept for the process.
const agents = new Map<string, ProxyAgent>();
export function proxyAgent(proxy: string): ProxyAgent {
  let a = agents.get(proxy);
  if (!a) { a = new ProxyAgent(proxy); agents.set(proxy, a); }
  return a;
}
