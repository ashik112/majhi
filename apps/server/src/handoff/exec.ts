import type { BaseEnv, RunMount, Spawner } from "@majhi/acp";
import { detectSecrets, type Task } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import { taskTerminalEnv } from "../terminal/task-terminal.ts";
import type { ExecResult } from "./service.ts";

/** The most output kept while a command runs. The end of it is what a failure is read from. */
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
 * Runs one shell line in a task's worktree, the way the task's own shell would: the same spawner
 * (a runner container when there is one, with its memory and process limits) and mounts, and the
 * task shell's environment, built from scratch: no account, no connection values, nothing from
 * majhi's own. It is stopped at `timeoutMs`. What it printed is masked for secrets.
 */
export function execInTask(deps: ExecDeps) {
  return async (taskId: string, cwd: string, command: string, timeoutMs: number): Promise<ExecResult> => {
    const started = Date.now();
    const task = deps.task(taskId);
    if (task === undefined)
      return { code: null, timedOut: false, output: "", ms: 0, error: "the task is gone" };
    let spawned: Awaited<ReturnType<Spawner>>;
    try {
      spawned = await deps.spawner({
        command: { command: "/bin/sh", args: ["-c", command] },
        env: taskTerminalEnv(deps.base),
        cwd,
        task: taskId,
        mounts: [{ path: task.folder }, ...(await deps.repoMounts(task))],
      });
    } catch (err) {
      return { code: null, timedOut: false, output: "", ms: Date.now() - started, error: errorMessage(err) };
    }
    const { child } = spawned;
    child.stdin.end();
    let out = "";
    const take = (d: Buffer) => {
      out += d.toString();
      if (out.length > KEEP_CHARS * 2) out = out.slice(out.length - KEEP_CHARS);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    return await new Promise<ExecResult>((resolve) => {
      let done = false;
      const finish = (code: number | null, error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          code,
          timedOut,
          output: maskSecrets(out.slice(-KEEP_CHARS)),
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
