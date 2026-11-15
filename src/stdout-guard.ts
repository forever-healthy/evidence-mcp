// stdout is the MCP channel (JSON-RPC over stdio): one stray line from a
// dependency breaks the client's parser. console.log / info / debug go to
// stderr instead, as console.warn and console.error already do. Imported first
// in src/index.ts, before any module that might print.
const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
