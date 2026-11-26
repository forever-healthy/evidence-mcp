// Are our own stage hosts there — the fetch proxy, the Playwright servers, the
// Chromes? A host that is off or off the network costs every request a long
// connect timeout (2026-11-13: a stage host offline, the fetch proxy waited ~24 s
// per page, and stage 2 waited for it). So before a request goes to a stage
// host, one TCP connect says whether it is there, and the answer is kept:
//   up    for UP_MS (60 s): requests go ahead without asking again
//   down  for DOWN_MS (5 min): its requests are skipped at once
//         ("skipped <stage>: host down …"); then it is asked again
// The same check is the health fh_info, the TUI and /status show. Free: no
// request reaches a site.
//
// The address: a name can resolve to many (this VM's own name: 30 — link-local IPv6
// first, Docker bridges, the LAN, the tailnet). A link-local address comes back
// without its zone and cannot be dialled (AI4L-dev 2026-11-20: every Chrome connect
// "ECONNREFUSED fe80::…:9001" while a connect by name was up). So the addresses are
// tried in turn, link-local left out, and the first that accepts is the host's
// address — the one the Chrome stage dials (src/browser.ts cdpUrl), so the health
// check tests what a download uses.
import { lookup } from "node:dns/promises";
import { connect, isIP } from "node:net";

const UP_MS = 60_000, DOWN_MS = 5 * 60_000, PROBE_MS = 3000;
export type HostState = { up: boolean; ms: number; at: number; error: string | null; address?: string };
const seen = new Map<string, HostState>();
const key = (host: string, port: number) => `${host}:${port}`;

// One TCP connect to one address, timed.
function connectOnce(address: string, port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = connect({ host: address, port });
    const done = (error: string | null) => { s.destroy(); resolve(error); };
    s.setTimeout(timeoutMs, () => done(`no answer within ${timeoutMs / 1000} s`));
    s.once("connect", () => done(null));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code ?? e.message));
  });
}

// The addresses to try: an IP or localhost as is; a name's addresses in resolver order, link-local out.
export async function candidates(host: string, lookupImpl = lookup): Promise<string[]> {
  if (host === "localhost" || isIP(host)) return [host];
  const all = await lookupImpl(host, { all: true, order: "verbatim" });
  const usable = all.map((a) => a.address).filter((a) => !/^fe[89ab]/i.test(a));
  return usable.length ? usable : [host];
}

// The host's state: its addresses tried in turn until one accepts, timed as a whole.
export async function probe(host: string, port: number, timeoutMs = PROBE_MS): Promise<HostState> {
  const t0 = Date.now();
  let list: string[];
  try { list = await candidates(host); }
  catch (e) { return { up: false, ms: Date.now() - t0, at: Date.now(), error: (e as NodeJS.ErrnoException).code ?? String(e) }; }
  let first: string | null = null;
  for (const address of list) {
    const left = timeoutMs - (Date.now() - t0);
    if (left <= 0) break;
    const error = await connectOnce(address, port, left);
    if (!error) return { up: true, ms: Date.now() - t0, at: Date.now(), error: null, address };
    first ??= error;
  }
  return { up: false, ms: Date.now() - t0, at: Date.now(), error: first ?? `no answer within ${timeoutMs / 1000} s` };
}

// The host's state, from memory while it is fresh, else asked; a host newly
// found down is reported once through onDown (an alert).
export async function hostState(host: string, port: number, onDown?: (s: HostState) => void): Promise<HostState> {
  const k = key(host, port), now = Date.now(), old = seen.get(k);
  if (old && now - old.at < (old.up ? UP_MS : DOWN_MS)) return old;
  const s = await probe(host, port);
  seen.set(k, s);
  if (!s.up && (!old || old.up)) onDown?.(s);
  return s;
}

// The words of a skip line: "host down (ECONNREFUSED, since 16:31)".
export const downNote = (s: HostState) => `host down (${s.error}, since ${new Date(s.at).toTimeString().slice(0, 5)})`;

export function forgetHosts(): void { seen.clear(); }   // tests
