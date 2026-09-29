// Writes src/layadSource.ts from py/layad.py, so the bundled helper carries the Python service.
// Run `pnpm --filter @majhi/host embed` after editing py/layad.py. A test fails when they differ.
import { readFileSync, writeFileSync } from "node:fs";

const py = readFileSync(new URL("../py/layad.py", import.meta.url), "utf8");
const out = `// Generated from py/layad.py by scripts/embed-layad.mjs. Do not edit.\nexport const LAYAD_SOURCE = ${JSON.stringify(py)};\n`;
writeFileSync(new URL("../src/layadSource.ts", import.meta.url), out);
