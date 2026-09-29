/**
 * Reports what the key loader would do on this machine, and changes nothing:
 * no `ssh-add` add, no Keychain load. Prints paths and short fingerprints.
 *
 *   pnpm --filter @majhi/host ssh:dry-run
 */
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { runCommand } from "./runCommand.ts";
import { createSsh } from "./ssh.ts";

const home = homedir();
const ssh = createSsh({
  run: runCommand,
  readText: (path) => readFile(path, "utf8").catch(() => undefined),
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  home,
  env: process.env,
  log: () => undefined,
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
