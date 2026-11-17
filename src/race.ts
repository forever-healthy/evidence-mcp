// Requests within a download stage run side by side (2026-11-13): stage 1 the
// plain fetch and the fetch proxy, stage 2 every browser, stage 3 every
// unlocker; the first valid result wins.
//
// Every request is logged from start to end, exactly one closing line each:
//   try <name>                 when it starts
//   ok <name> / failed <name>: <reason>   when it returns by itself
//   aborted <name>: <why>      when another request of its stage decided it
//                              ("zyte won", "fetch had HTTP 404"); it is cancelled
//                              then — the browser tab closed, the connection dropped
//   abandoned <name>: server stopped   when the server exits while it runs
// So no "try" stays without its end, and the log tells what became of each.

type Open = { abandon(): void };
const OPEN = new Set<Open>();

export type Req = {
  signal: AbortSignal;               // aborted when the request is cancelled
  abort(why: string): void;          // cancel it and write "aborted <name>: <why>"
  close(line: string): boolean;      // write its closing line; false when it was closed already (aborted)
};

export function openRequest(write: (line: string) => void, name: string): Req {
  const ctrl = new AbortController();
  let closed = false;
  const entry: Open = { abandon: () => { if (!closed) { closed = true; write(`abandoned ${name}: server stopped`); } } };
  OPEN.add(entry);
  write(`try ${name}`);
  return {
    signal: ctrl.signal,
    abort: (why) => { if (closed) return; closed = true; OPEN.delete(entry); write(`aborted ${name}: ${why}`); ctrl.abort(new Error(`aborted: ${why}`)); },
    close: (line) => { if (closed) return false; closed = true; OPEN.delete(entry); write(line); return true; },
  };
}

// The server is exiting: every request still running gets its "abandoned" line
// (the log is written synchronously, so the lines reach the file).
export function abandonAll(): void {
  for (const e of OPEN) e.abandon();
  OPEN.clear();
}

// One request of a stage: its name, how to run it, how to cancel it.
export type Task<T> = { name: string; go: () => Promise<T>; abort: (why: string) => void };

// Run a stage's tasks at once. Resolves with the first ok result — the rest are
// aborted ("<winner> won") — or, when a result is decisive (a 404 or 410: the
// page is not there), with no winner, the rest aborted ("<name> had <reason>");
// else, when all failed, with every result in task order. A task never rejects
// (its failure is a result with ok: false).
export async function firstOk<T extends { ok: boolean }>(tasks: Task<T>[], decisive: (r: T) => string | null = () => null): Promise<{ won: T | null; results: T[] }> {
  if (!tasks.length) return { won: null, results: [] };
  const results: T[] = new Array(tasks.length);
  const settled = new Array(tasks.length).fill(false);
  return new Promise((resolve) => {
    let left = tasks.length, done = false;
    const end = (won: T | null, why: string) => {
      done = true;
      tasks.forEach((t, j) => { if (!settled[j]) t.abort(why); });
      resolve({ won, results });
    };
    tasks.forEach((task, i) => {
      task.go().then((r) => {
        results[i] = r; settled[i] = true;
        if (done) return;
        const gone = r.ok ? null : decisive(r);
        if (r.ok) end(r, `${task.name} won`);
        else if (gone) end(null, `${task.name} had ${gone}`);   // "fetch had HTTP 404": the other's answer, not this request's
        else if (--left === 0) { done = true; resolve({ won: null, results }); }
      });
    });
  });
}

// A signal that fires on a timeout or when the given one does (AbortSignal.any
// needs Node 20; the package runs on 18).
export function timeoutOr(ms: number, signal?: AbortSignal): AbortSignal {
  if (!signal) return AbortSignal.timeout(ms);
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
  if (signal.aborted) { clearTimeout(t); c.abort(signal.reason); }
  else signal.addEventListener("abort", () => { clearTimeout(t); c.abort(signal.reason); }, { once: true });
  return c.signal;
}
