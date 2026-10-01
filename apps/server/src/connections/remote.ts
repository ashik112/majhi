import { execFile } from "node:child_process";

const REMOTE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 512 * 1024;

export interface RemoteRun {
  /** Null when ssh could not start or was stopped at the timeout. */
  code: number | null;
  /** stdout and stderr together. */
  output: string;
}

export type RemoteRunFn = (alias: string, command: string) => Promise<RemoteRun>;

/**
 * Runs a command on a host of ~/.ssh/config from majhi, the way its git reaches hosts: majhi's own
 * SSH agent, BatchMode, stdin closed. The alias comes after `--`, so it can never pass for an option.
 * Never rejects.
 */
export const runRemote: RemoteRunFn = (alias, command) =>
  new Promise((resolve) => {
    const child = execFile(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", alias, command],
      { timeout: REMOTE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: process.env },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
        resolve({ code, output: `${stdout}${stderr === "" ? "" : `\n${stderr}`}`.trim() });
      },
    );
    child.stdin?.end();
  });
