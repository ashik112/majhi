import { execFile } from "node:child_process";
import { sshTargetArgs } from "@majhi/shared";

const REMOTE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 512 * 1024;

export interface RemoteRun {
  /** Null when ssh could not start or was stopped at the timeout. */
  code: number | null;
  /** stdout and stderr together. */
  output: string;
}

/** `key`: the public file of the key to use, `~/.ssh/<name>.pub`, so the agent signs with that key. */
export type RemoteRunFn = (alias: string, command: string, key?: string | undefined) => Promise<RemoteRun>;

/**
 * Runs a command on a host of ~/.ssh/config from majhi, the way its git reaches hosts: majhi's own
 * SSH agent, BatchMode, stdin closed. The alias comes after `--`, so it can never pass for an option.
 * Never rejects.
 */
export const runRemote: RemoteRunFn = (alias, command, key) =>
  new Promise((resolve) => {
    const child = execFile(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        ...sshTargetArgs(alias, key === undefined ? undefined : { pub: key }),
        command,
      ],
      { timeout: REMOTE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: process.env },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
        resolve({ code, output: `${stdout}${stderr === "" ? "" : `\n${stderr}`}`.trim() });
      },
    );
    child.stdin?.end();
  });
