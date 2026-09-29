// node-pty's macOS prebuilds ship `spawn-helper` without the execute bit, and
// spawning a terminal then fails with `posix_spawnp failed`. Set the bit.
// Linux has no prebuilds (node-pty compiles from source), so nothing to do there.
import { chmodSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
let root;
try {
  // Resolves through pnpm's symlinks to the real package folder.
  root = dirname(realpathSync(require.resolve("node-pty/package.json")));
} catch {
  process.exit(0); // not installed yet, or filtered out of this install
}

const prebuilds = join(root, "prebuilds");
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
