#!/usr/bin/env node
import "./stdout-guard.js";   // console.log / info / debug to stderr: stdout carries only the protocol (#56)
import "./env-load.js";   // .env into the environment before any module reads it (src/env-load.ts)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveTiers } from "./config.js";
import { verifyProblems } from "./verify/config.js";
import { abandonAll } from "./race.js";
import { log, migrateLogName } from "./log.js";
import { migrateWalls } from "./walls.js";
import { startStats } from "./stats.js";
import { INSTRUCTIONS, pkg, registerTools } from "./tools.js";

const server = new McpServer(
  { name: pkg.name, version: pkg.version },
  { instructions: INSTRUCTIONS },
);
registerTools(server);
startStats(pkg);   // this process's cache counters, published as <library>/.servers/<host>-<pid>.json for the TUI
migrateLogName();
migrateWalls();
log("startup", null, `${pkg.name} ${pkg.version}`);
// Exiting while downloads run: each open request gets its "abandoned" line (src/race.ts).
process.on("exit", abandonAll);
for (const problem of [...resolveTiers().problems, ...verifyProblems()]) log("startup", null, `!! ${problem}`);   // a misconfigured source list or decision model, said once, where the TUI shows it

const transport = new StdioServerTransport();
await server.connect(transport);
