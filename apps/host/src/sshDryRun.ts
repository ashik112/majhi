/**
 * Reports what the key loader would do on this machine, and changes nothing:
 * no `ssh-add` add, no Keychain load, no keyring change. Prints paths and
 * short fingerprints.
 *
 *   pnpm --filter @majhi/host ssh:dry-run
 */
import { readFile } from "node:fs/promises";
import { parseHostConfig } from "./config.ts";
import { createPlatform, currentOs, processDeps } from "./platform/index.ts";
import { createSsh } from "./ssh.ts";

const os = currentOs();
if (os === undefined) {
  process.stderr.write("majhi's host helper runs on macOS, Linux and WSL2.\n");
  process.exit(1);
}
const { home, majhiHome } = parseHostConfig();
const log = (): void => undefined;
const deps = processDeps(os, { home, majhiHome, log });
const platform = createPlatform(os, deps);
const ssh = createSsh({
  run: deps.run,
  readText: (path) => readFile(path, "utf8").catch(() => undefined),
  exists: deps.exists,
  home,
  path: deps.path,
  find: deps.find,
  agent: platform.sshAgent,
  keyring: platform.keyring,
  log,
  dryRun: true,
});

const report = await ssh.inspect();
const socket = report.socket ?? "none";
process.stdout.write(`agent socket: ${socket}\nkeys in the agent: ${report.status.loaded}\n`);
for (const key of report.keys) {
  process.stdout.write(
    `  ${key.state.padEnd(16)} ${key.path}${key.fingerprint ? `  ${key.fingerprint}` : ""}\n`,
  );
}
if (report.keys.length === 0) process.stdout.write("  no key files found\n");
if (report.status.error) process.stdout.write(`error: ${report.status.error}\n`);
