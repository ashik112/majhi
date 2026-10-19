import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, type ExecResult, exec, killTree } from "./exec.ts";
import type { AccountRuntime, Command, RuntimeOptions } from "./index.ts";
import type { SpawnRequest } from "./spawn.ts";

/**
 * A short-lived process of an agent CLI that is not a session: the version check, the sign-in status, the
 * session-options probe and the usage read. With a runner (`options.spawner`) each one is its own runner
 * container that mounts only the account's own home and a scratch folder of its own, so the server image
 * carries no agent CLI and a probe sees nothing of another account or workspace. Without one (tests, and
 * MAJHI_RUNNER=local) it is a child of majhi.
 */
export interface ToolProcess {
  child: ChildProcessWithoutNullStreams;
  /** The folder the process works in: the container's `/tmp`, or a temporary folder next to majhi. */
  cwd: string;
  /** Stops it and removes what it used. Safe to call twice. */
  close(): Promise<void>;
}

type Where = Pick<RuntimeOptions, "spawner">;

/** The request a probe makes of the runner: no task folder, only the account's home. */
export function toolRequest(
  account: AccountRuntime | undefined,
  command: Command,
  env: Record<string, string>,
): SpawnRequest {
  return {
    command,
    env,
    cwd: "/tmp",
    scratch: true,
    ...(account === undefined ? {} : { account }),
  };
}

/** Starts `command` where `options` say a probe runs. */
export async function startTool(
  options: Where,
  account: AccountRuntime | undefined,
  command: Command,
  env: Record<string, string>,
): Promise<ToolProcess> {
  if (options.spawner !== undefined) {
    const spawned = await options.spawner(toolRequest(account, command, env));
    return {
      child: spawned.child,
      cwd: spawned.cwd,
      close: async () => spawned.kill(),
    };
  }
  const cwd = await mkdtemp(join(tmpdir(), "majhi-probe-"));
  const child = spawn(command.command, command.args, {
    env,
    cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    child,
    cwd,
    close: async () => {
      killTree(child);
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

/** Runs `command args` to completion where `options` say a probe runs. Never rejects. */
export async function execTool(
  options: Where,
  account: AccountRuntime | undefined,
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ExecResult> {
  if (options.spawner === undefined) return exec(command, args, env, timeoutMs);
  let proc: ToolProcess;
  try {
    proc = await startTool(options, account, { command, args }, env);
  } catch (err) {
    return { code: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) };
  }
  try {
    return await collect(proc.child, () => void proc.close(), command, timeoutMs);
  } finally {
    await proc.close();
  }
}
