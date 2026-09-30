import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { BaseEnv, RunMount, SpawnRequest, TtyLaunch } from "@majhi/acp";
import type { Task } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { Terminal, TerminalManager, TerminalSpec } from "./manager.ts";

/** A task's shell is killed after this long, so a forgotten one does not run for days. */
export const TASK_TERMINAL_MAX_MS = 8 * 60 * 60_000;

/** The one terminal key of a task. */
export const taskTerminalKey = (task: string): string => `task-term:${task}`;

export interface TaskTerminalDeps {
  terminals: TerminalManager;
  /** Throws a UserError when the task does not exist. */
  task: (id: string) => Task;
  /** The folder that holds every task folder. */
  tasksDir: () => Promise<string>;
  base: BaseEnv;
  /** Each task repo's `.git`, as a run mounts them. */
  repoMounts: (task: Task) => Promise<RunMount[]>;
  /** Starts the shell in a runner container. Absent without a runner: the shell runs next to majhi. */
  tty?: ((req: SpawnRequest) => Promise<TtyLaunch>) | undefined;
}

/** Runs bash when the image has it, else sh. */
const SHELL_SCRIPT = "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";

/**
 * The shell's whole environment. Built from scratch: no account, no connection values and nothing
 * from majhi's own environment. HOME is `/tmp`, so the shell has no config home to read or write.
 */
export function taskTerminalEnv(base: BaseEnv): Record<string, string> {
  return { PATH: base.PATH, HOME: "/tmp", TERM: "xterm-256color", LANG: base.LANG ?? "C.UTF-8" };
}

/** The task folder, checked: it exists and, symlinks followed, sits inside the tasks folder. */
export async function taskFolder(task: Task, tasksDir: string): Promise<string> {
  const missing = () => new UserError(`The folder of ${task.id} is not there.`, 409);
  let real: string;
  try {
    real = await realpath(task.folder);
    if (!(await stat(real)).isDirectory()) throw missing();
  } catch {
    throw missing();
  }
  const root = await realpath(tasksDir).catch(() => tasksDir);
  const rel = relative(root, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UserError(`The folder of ${task.id} is outside the tasks folder.`, 409);
  }
  return task.folder;
}

/**
 * Opens the task's shell, or returns the one that runs. It starts in the task folder with the
 * mounts and limits of a run but no account home and no secrets: in a runner container when there
 * is a runner, else as a shell next to majhi. Once it has exited, opening starts a new one.
 */
export async function openTaskTerminal(deps: TaskTerminalDeps, taskId: string): Promise<Terminal> {
  const key = taskTerminalKey(taskId);
  const live = deps.terminals.running(key);
  if (live !== undefined) return live;

  const task = deps.task(taskId);
  const cwd = await taskFolder(task, await deps.tasksDir());
  const env = taskTerminalEnv(deps.base);
  let spec: TerminalSpec;
  if (deps.tty === undefined) {
    const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    spec = { key, command: shell, args: [], env, cwd, maxRuntimeMs: TASK_TERMINAL_MAX_MS };
  } else {
    const launch = await deps.tty({
      command: { command: "/bin/sh", args: ["-c", SHELL_SCRIPT] },
      env,
      cwd,
      mounts: [{ path: task.folder }, ...(await deps.repoMounts(task))],
    });
    spec = {
      key,
      command: launch.command,
      args: launch.args,
      env: launch.env,
      cwd,
      maxRuntimeMs: TASK_TERMINAL_MAX_MS,
      stop: launch.stop,
    };
  }
  // Two opens that overlap while the runner starts end up with one terminal: attach is synchronous.
  return deps.terminals.attach(spec);
}
