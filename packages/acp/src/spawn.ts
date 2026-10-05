import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { killTree } from "./exec.ts";
import type { AccountRuntime, Command } from "./index.ts";

/**
 * Where an agent session's process runs (SPEC 4.2, 6). The session code only sees this interface:
 * `localSpawner` starts the adapter next to majhi, `dockerSpawner` (runner/docker.ts) in its own
 * runner container that sees only what the run may use.
 */
export interface SpawnRequest {
  command: Command;
  /** The run's environment, built from scratch (env.ts). The only values the agent sees. */
  env: Record<string, string>;
  /** The task folder. */
  cwd: string;
  /** The account whose home the run mounts. Absent for a run that has none, like a task terminal. */
  account?: AccountRuntime | undefined;
  /** More paths the run needs, like each task repo's `.git`. */
  mounts?: RunMount[];
  /** `cwd` is a throwaway folder: a runner uses its own instead of mounting one. */
  scratch?: boolean;
  /**
   * The task this run belongs to, like `PRV-53`. A runner labels its container with it
   * (`majhi.task`) and joins the task's own networks, where its service containers run.
   */
  task?: string;
  /** Resource caps for this run only, in place of the runner's own (a hand-off check is short and runs alone). */
  limits?: { cpus?: string; memory?: string };
}

export interface RunMount {
  path: string;
  readOnly?: boolean;
}

export interface Spawned {
  child: ChildProcessWithoutNullStreams;
  /** The working directory the agent sees; the ACP session is opened there. */
  cwd: string;
  /** Stops the process and everything it started. Safe to call twice. */
  kill(): void;
}

export type Spawner = (request: SpawnRequest) => Promise<Spawned>;

/** Starts the adapter as a child of majhi, in its own process group. */
export const localSpawner: Spawner = async (req) => {
  const child = spawn(req.command.command, req.command.args, {
    env: req.env,
    cwd: req.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, cwd: req.cwd, kill: () => killTree(child) };
};
