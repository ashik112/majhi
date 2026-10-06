import { type BaseEnv, type RunMount, type Spawner, withToolsPath } from "@majhi/acp";
import { detectSecrets, type Task } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import type { PackageStoreFor } from "../runs/package-cache.ts";
import { taskTerminalEnv } from "../terminal/task-terminal.ts";
import { HANDOFF_CPU_SHARES } from "./limits.ts";
import { OutputKeeper } from "./logs.ts";
import type { ExecLimits, ExecResult } from "./service.ts";

/** The end of the output the card shows and the test counter reads: what a failure is read from. */
const KEEP_CHARS = 64 * 1024;
/** After a kill, how long to wait for the process to close before giving up on it. */
const CLOSE_WAIT_MS = 5_000;

export interface ExecDeps {
  /** The sessions' spawner: next to majhi, or a runner container of its own. */
  spawner: Spawner;
  base: BaseEnv;
  task: (id: string) => Task | undefined;
  /** Each task repo's `.git`, as a run mounts them. */
  repoMounts: (task: Task) => Promise<RunMount[]>;
  /** The workspace's shared package store, so an install never writes `.pnpm-store` into the worktree. */
  packages?: PackageStoreFor | undefined;
  /** The workspace's tools folder, which agents install command-line tools into: the check finds them on PATH as a run does. */
  tools?:
    | ((task: Task) => Promise<{ mounts: RunMount[]; env: Record<string, string> } | undefined>)
    | undefined;
  /**
   * What the check's `docker` needs to reach this task's containers through majhi: the shim's two
   * variables, and the end of the token. Absent when majhi cannot run containers.
   */
  dockerShim?:
    | ((task: string) => { env: Record<string, string>; release: () => void } | undefined)
    | undefined;
}

/** Hides what looks like a secret in text that came out of a command. */
export function maskSecrets(text: string): string {
  const found = detectSecrets(text);
  if (found.length === 0) return text;
  let out = text;
  for (const m of [...found].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, m.start)}[hidden]${out.slice(m.end)}`;
  }
  return out;
}

/**
 * Runs one shell line in a task's worktree, the way the task's own run would: the same spawner
 * (a runner container when there is one, with its memory and process limits), mounts, package
 * caches and tools folder, and an environment built from scratch: no account, no connection values,
 * nothing from majhi's own. HOME is the workspace's own home folder, which holds no account and
 * keeps tool caches between checks. It is stopped at `timeoutMs`. What it printed is masked for
 * secrets, and kept whole up to the log cap.
 */
export function execInTask(deps: ExecDeps) {
  return async (
    taskId: string,
    cwd: string,
    command: string,
    timeoutMs: number,
    limits?: ExecLimits,
  ): Promise<ExecResult> => {
    const started = Date.now();
    const task = deps.task(taskId);
    if (task === undefined)
      return { code: null, timedOut: false, output: "", log: "", ms: 0, error: "the task is gone" };
    let spawned: Awaited<ReturnType<Spawner>>;
    const shim = deps.dockerShim?.(taskId);
    try {
      const store = await deps.packages?.(task);
      const tools = await deps.tools?.(task);
      spawned = await deps.spawner({
        command: { command: "/bin/sh", args: ["-c", command] },
        env: withToolsPath({
          ...store?.env,
          ...tools?.env,
          ...taskTerminalEnv(deps.base, store?.home),
          ...shim?.env,
        }),
        cwd,
        task: taskId,
        ...(limits === undefined
          ? {}
          : {
              limits: {
                cpus: String(limits.cpus),
                memory: limits.memory,
                cpuShares: HANDOFF_CPU_SHARES,
              },
            }),
        mounts: [
          { path: task.folder },
          ...(await deps.repoMounts(task)),
          ...(store?.mounts ?? []),
          ...(tools?.mounts ?? []),
        ],
      });
    } catch (err) {
      shim?.release();
      return {
        code: null,
        timedOut: false,
        output: "",
        log: "",
        ms: Date.now() - started,
        error: errorMessage(err),
      };
    }
    const { child } = spawned;
    child.stdin.end();
    const out = new OutputKeeper();
    const take = (d: Buffer) => out.push(d.toString());
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    return await new Promise<ExecResult>((resolve) => {
      let done = false;
      const finish = (code: number | null, error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        shim?.release();
        const kept = out.result();
        const log = maskSecrets(kept.text);
        resolve({
          code,
          timedOut,
          output: log.slice(-KEEP_CHARS),
          log,
          ...(kept.cut > 0 ? { cut: kept.cut } : {}),
          ms: Date.now() - started,
          ...(error === undefined ? {} : { error }),
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        spawned.kill();
        // A process that ignores the kill must not hold the check forever.
        const wait = setTimeout(() => finish(null), CLOSE_WAIT_MS);
        wait.unref();
      }, timeoutMs);
      timer.unref();
      child.on("error", (err) => {
        if (child.pid === undefined) finish(null, err.message);
      });
      child.on("close", (code) => finish(code));
    });
  };
}
