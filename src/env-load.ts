import { loadDotenv } from "./env.js";

// Imported first by src/index.ts, for its side effect: ESM evaluates imports
// before the importing module's own code, so a loadDotenv() call in index.ts
// would run after src/layout.ts had already resolved FH_EVIDENCE_DIR from an
// environment the .env file had not reached yet. This module runs ahead of
// every other import.
loadDotenv();
