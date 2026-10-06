import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AccountRuntime, RunMount, Spawned, Spawner } from "@majhi/acp";
import { type ProcessContainer, type ProcessInfo, processHost, type StoppedBy } from "@majhi/shared";
import { classifyCommand, type GateConnection } from "../connections/gate.ts";
import { redactSecrets } from "../connections/redact.ts";
import { errorMessage, UserError } from "../errors.ts";
import { findPort, OutputTail } from "./tail.ts";

/** Running processes per task, at most. */
export const PROCESS_LIMIT = 5;
/** Ended processes kept per task for the card and `output`, at most. */
const ENDED_KEPT = 20;
/** Output changes reach the room at most this often per task. */
export const OUTPUT_THROTTLE_MS = 500;
/** How long a stop waits for the process to go before it gives up waiting. */
const STOP_WAIT_MS = 5_000;

/** What a process of one agent runs with: the same as the agent's session. */
export interface ProcessLaunch {
  /** The task folder. A process's cwd must be inside it. */
  folder: string;
  /** The session's environment, from `buildEnv`. */
  env: Record<string, string>;
  account: AccountRuntime;
  /** The session's mounts, like each task repo's `.git`. */
  mounts: RunMount[];
  /** Removes what this launch wrote, like its connection files. Runs once the process has ended. */
  cleanup?: (() => Promise<void>) | undefined;
  /** The secret values of its connections, kept out of its output (5.14). */
  secrets?: readonly { name: string; value: string }[] | undefined;
  /** What the gate checks a command against: the connections the process holds (5.14). */
  gate?: readonly GateConnection[] | undefined;
}

/** A process's output, with the secret values of its connections kept out (5.14). */
function tailFor(launch: ProcessLaunch | undefined): OutputTail {
  const tail = new OutputTail();
  const secrets = launch?.secrets ?? [];
  if (secrets.length > 0) tail.redactWith((line) => redactSecrets(line, secrets));
  return tail;
}

/**
 * A background process runs without the CLI's permission prompt, so one that would change a
 * connection is refused: run in the agent's own shell, it asks the owner (5.14).
 */
function refuseConnectionWrite(command: string, launch: ProcessLaunch | undefined): void {
  if (launch?.gate === undefined) return;
  const verdict = classifyCommand(command, launch.gate);
  if (verdict.kind !== "write") return;
  const write = verdict.writes[0];
  throw new UserError(
    `This changes ${write?.connection ?? "a connection"} (${write?.why ?? "a write"}). Run it in your own shell instead, so the owner can approve it.`,
    409,
  );
}

export interface ProcessDeps {
  /** The sessions' spawner: next to majhi, or a runner container of its own. */
  spawner: Spawner;
  launch: (task: string, agent: string) => Promise<ProcessLaunch>;
  /**
   * Makes sure the task's network exists before a process starts in a runner, so the process joins it
   * under its name. Resolves false when there is no such network (majhi does not run in Docker).
   */
  network?: (task: string) => Promise<boolean>;
  /** Every process of the task, after any change. Output changes come at most every 500 ms. */
  onChange?: (task: string, processes: ProcessInfo[]) => void;
  /**
   * A process ended. `wakes` when it was a `wait` process that exited by itself: its agent gets
   * a message. Otherwise a stop, or a `wait: false` process.
   */
  onEnded?: (process: ProcessInfo, wakes: boolean) => void;
  now?: () => Date;
  limit?: number;
  throttleMs?: number;
}

/** What a managed run may change about its container line while it runs. */
export interface ManagedContext {
  /** Adds what became known after the start, like the address of a preview. */
  update(patch: Partial<ProcessContainer>): void;
}

/**
 * A process majhi runs itself, for a container (PRV-53): no shell, no runner and no agent
 * environment. `spawn` starts it, and starts it again on a restart.
 */
export interface ManagedRun {
  spawn(ctx: ManagedContext): Promise<Spawned>;
  container: ProcessContainer;
}

export interface StartInput {
  task: string;
  agent: string;
  command: string;
  name?: string | undefined;
  cwd?: string | undefined;
  wait: boolean;
  /** Runs `spawn` instead of `command`. `command` then only describes it, and `cwd` must be absolute. */
  managed?: ManagedRun | undefined;
}

interface Proc {
  info: ProcessInfo;
  tail: OutputTail;
  spawned: Spawned | undefined;
  /** Resolves when the current child has closed. */
  closed: Promise<void>;
  /** Set for a container process. */
  managed?: ManagedRun | undefined;
  /** Set while the spawner is starting the child (a runner container can take a while). */
  spawning?: Promise<void> | undefined;
  /** The current launch's cleanup, run when its child closes. */
  cleanup?: (() => Promise<void>) | undefined;
  /** When its agent last saw this run ended, through `output` or `list`. Cleared on a restart. */
  readAt?: string | undefined;
}

/**
 * Background processes that majhi runs for agents (SPEC 5.15), in memory per task. Each runs
 * `/bin/sh -c <command>` through the sessions' spawner, with the session's environment and
 * mounts, stdin closed. Ids are `p1`, `p2` per task and never reused.
 */
export class ProcessManager {
  private readonly tasks = new Map<string, Map<string, Proc>>();
  private readonly counters = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly now: () => Date;
  private readonly limit: number;
  private readonly throttleMs: number;

  constructor(private readonly deps: ProcessDeps) {
    this.now = deps.now ?? (() => new Date());
    this.limit = deps.limit ?? PROCESS_LIMIT;
    this.throttleMs = deps.throttleMs ?? OUTPUT_THROTTLE_MS;
  }

  /** Every process of the task, oldest first. */
  list(task: string): ProcessInfo[] {
    return [...(this.tasks.get(task)?.values() ?? [])].map((p) => this.view(p));
  }

  /** Every process of every task. */
  listAll(): ProcessInfo[] {
    return [...this.tasks.keys()].flatMap((task) => this.list(task));
  }

  get(task: string, id: string): ProcessInfo | undefined {
    const p = this.tasks.get(task)?.get(id);
    return p === undefined ? undefined : this.view(p);
  }

  running(task: string): ProcessInfo[] {
    return this.list(task).filter((p) => p.status === "running");
  }

  /** Running `wait` processes: the task keeps running until they end. */
  waiting(task: string): ProcessInfo[] {
    return this.running(task).filter((p) => p.wait);
  }

  /** The last `lines` lines of output. */
  output(task: string, id: string, lines: number): string[] {
    return this.find(task, id).tail.last(lines);
  }

  /**
   * `agent` was shown `shown`, with its status. Counts as reading the end when the run had ended
   * and `agent` started it: its end then wakes nobody.
   */
  markRead(task: string, shown: ProcessInfo, agent: string): void {
    const proc = this.tasks.get(task)?.get(shown.id);
    if (proc === undefined || proc.info.startedAt !== shown.startedAt) return;
    if (shown.status === "running" || shown.agent !== agent) return;
    proc.readAt = this.now().toISOString();
  }

  /** Whether the agent of `p` read this run after it ended. */
  readAfterEnd(p: ProcessInfo): boolean {
    const proc = this.tasks.get(p.task)?.get(p.id);
    if (proc === undefined || proc.info.startedAt !== p.startedAt) return false;
    const { readAt } = proc;
    const { endedAt } = proc.info;
    return readAt !== undefined && endedAt !== undefined && Date.parse(readAt) >= Date.parse(endedAt);
  }

  async start(input: StartInput): Promise<ProcessInfo> {
    const managed = input.managed;
    // A managed run has no runner environment to build, and its folder is the task's own.
    const launch = managed === undefined ? await this.deps.launch(input.task, input.agent) : undefined;
    try {
      refuseConnectionWrite(input.command, launch);
    } catch (err) {
      await launch?.cleanup?.().catch(() => undefined);
      throw err;
    }
    const cwd = launch === undefined ? (input.cwd ?? "") : await containedCwd(launch.folder, input.cwd);
    // Containers have their own limit (`containers.per_task`), kept by the container service.
    const running = this.running(input.task).filter((p) => p.container === undefined);
    const same =
      managed === undefined ? running.find((p) => p.command === input.command && p.cwd === cwd) : undefined;
    if (same !== undefined) {
      throw new UserError(
        `${same.id} already runs \`${same.command}\` there. Read its output, or restart it.`,
        409,
      );
    }
    if (managed === undefined && running.length >= this.limit) {
      throw new UserError(
        `This task already runs ${running.length} processes, the most it may: ${running.map((p) => p.id).join(", ")}. Stop one first.`,
        409,
      );
    }
    const n = (this.counters.get(input.task) ?? 0) + 1;
    this.counters.set(input.task, n);
    const proc: Proc = {
      info: {
        id: `p${n}`,
        task: input.task,
        agent: input.agent,
        name: input.name ?? input.command,
        command: input.command,
        cwd,
        wait: input.wait,
        status: "running",
        startedAt: this.now().toISOString(),
        tail: [],
        ...(managed === undefined ? {} : { container: managed.container }),
      },
      tail: tailFor(launch),
      spawned: undefined,
      closed: Promise.resolve(),
      managed,
      cleanup: launch?.cleanup,
    };
    const procs = this.tasks.get(input.task) ?? new Map<string, Proc>();
    procs.set(proc.info.id, proc);
    this.tasks.set(input.task, procs);
    this.prune(input.task);
    try {
      await this.spawnTracked(proc, launch);
    } catch (err) {
      procs.delete(proc.info.id);
      this.changed(input.task, true);
      await this.cleanUp(proc);
      throw new UserError(`majhi could not start it: ${errorMessage(err)}`);
    }
    return this.view(proc);
  }

  /** Runs and forgets the current launch's cleanup. */
  private async cleanUp(proc: Proc): Promise<void> {
    const cleanup = proc.cleanup;
    proc.cleanup = undefined;
    await cleanup?.().catch(() => undefined);
  }

  /** Stops a running process and waits for it to go. An ended one is returned as it is. */
  async stop(task: string, id: string, by: StoppedBy): Promise<ProcessInfo> {
    const proc = this.find(task, id);
    await this.halt(proc, by);
    return this.view(proc);
  }

  /** Stops the process if it runs, then starts the same command again under the same id, for `agent`. */
  async restart(task: string, id: string, agent: string): Promise<ProcessInfo> {
    const proc = this.find(task, id);
    await this.halt(proc, "agent");
    const launch = proc.managed === undefined ? await this.deps.launch(task, agent) : undefined;
    try {
      refuseConnectionWrite(proc.info.command, launch);
    } catch (err) {
      await launch?.cleanup?.().catch(() => undefined);
      throw err;
    }
    proc.cleanup = launch?.cleanup;
    proc.readAt = undefined;
    proc.tail.clear();
    const secrets = launch?.secrets ?? [];
    proc.tail.redactWith((line) => redactSecrets(line, secrets));
    proc.info = {
      ...proc.info,
      agent,
      status: "running",
      startedAt: this.now().toISOString(),
      exitCode: undefined,
      stoppedBy: undefined,
      endedAt: undefined,
      port: undefined,
      ...(proc.managed === undefined ? {} : { container: proc.managed.container }),
    };
    try {
      await this.spawnTracked(proc, launch);
    } catch (err) {
      const message = `majhi could not start it: ${errorMessage(err)}`;
      proc.tail.note(message);
      this.ended(proc, null, undefined, { quiet: true });
      await this.cleanUp(proc);
      throw new UserError(message);
    }
    return this.view(proc);
  }

  /** Stops every running process of the task: it was stopped, closed or removed. */
  async stopTask(task: string, by: StoppedBy = "task"): Promise<void> {
    await Promise.all(
      [...(this.tasks.get(task)?.values() ?? [])].map((p) => this.halt(p, by).catch(() => undefined)),
    );
  }

  /** Stops the processes one agent started, when it leaves the team. */
  async stopAgent(task: string, agent: string): Promise<void> {
    await Promise.all(
      [...(this.tasks.get(task)?.values() ?? [])]
        .filter((p) => p.info.agent === agent)
        .map((p) => this.halt(p, "task").catch(() => undefined)),
    );
  }

  /** Server shutdown: no process outlives majhi. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((task) => this.stopTask(task)));
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Forgets a removed task. Its processes must be stopped first. */
  forget(task: string): void {
    const timer = this.timers.get(task);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(task);
    this.tasks.delete(task);
    this.counters.delete(task);
  }

  // ---------------------------------------------------------------------------

  private find(task: string, id: string): Proc {
    const proc = this.tasks.get(task)?.get(id);
    if (proc === undefined) throw new UserError(`There is no process ${id} in ${task}.`, 404);
    return proc;
  }

  private view(proc: Proc): ProcessInfo {
    return { ...proc.info, tail: proc.tail.last() };
  }

  /** `spawn`, with the start visible to a stop that arrives meanwhile. */
  private async spawnTracked(proc: Proc, launch: ProcessLaunch | undefined): Promise<void> {
    const spawning = this.spawn(proc, launch);
    proc.spawning = spawning;
    try {
      await spawning;
    } finally {
      if (proc.spawning === spawning) proc.spawning = undefined;
    }
  }

  /** Starts the child. Rejects when the spawner cannot start it (a runner that is not ready). */
  private async spawn(proc: Proc, launch: ProcessLaunch | undefined): Promise<void> {
    const { task } = proc.info;
    const spawned =
      proc.managed !== undefined
        ? await proc.managed.spawn({ update: (patch) => this.updateContainer(proc, patch) })
        : await this.spawnInRunner(proc, launch);
    proc.spawned = spawned;
    const { child } = spawned;
    child.stdin.end();
    const onData = (d: Buffer) => {
      const text = d.toString();
      proc.tail.write(text);
      // A container's own port is not this computer's: a preview shows its host link in `container` instead.
      const port = proc.info.port === undefined && proc.managed === undefined ? findPort(text) : undefined;
      if (port !== undefined) proc.info = { ...proc.info, port };
      this.changed(task, port !== undefined);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    proc.closed = new Promise<void>((done) => {
      let finished = false;
      const finish = (code: number | null, error?: string) => {
        if (finished) return;
        finished = true;
        if (proc.spawned === spawned) {
          if (error !== undefined) proc.tail.note(`It did not start: ${error}`);
          proc.spawned = undefined;
          this.ended(proc, code, proc.info.stoppedBy);
          void this.cleanUp(proc);
        }
        done();
      };
      // A child that never started gets no close event.
      child.on("error", (err) => {
        if (child.pid === undefined) finish(null, err.message);
      });
      child.on("close", (code) => finish(code));
    });
    this.changed(task, true);
  }

  /** `/bin/sh -c <command>` through the sessions' spawner, with the session's environment and mounts. */
  private async spawnInRunner(proc: Proc, launch: ProcessLaunch | undefined): Promise<Spawned> {
    if (launch === undefined) throw new Error("A process needs its launch settings.");
    const { task, command, cwd } = proc.info;
    // On the task's network under its name, so the agent's shell reaches what it serves.
    const joined = (await this.deps.network?.(task).catch(() => false)) === true;
    const host = processHost(proc.info.name, proc.info.id);
    if (joined) proc.info = { ...proc.info, host };
    return this.deps.spawner({
      command: { command: "/bin/sh", args: ["-c", command] },
      env: launch.env,
      cwd,
      task,
      ...(joined ? { networkAlias: host } : {}),
      account: launch.account,
      // The whole task folder, whatever the cwd, as the session sees it.
      mounts: [{ path: launch.folder }, ...launch.mounts],
    });
  }

  /** Adds to a container process's line, while it runs. */
  private updateContainer(proc: Proc, patch: Partial<ProcessContainer>): void {
    if (proc.info.container === undefined || proc.info.status !== "running") return;
    proc.info = { ...proc.info, container: { ...proc.info.container, ...patch } };
    this.changed(proc.info.task, true);
  }

  /** Kills the current child with `by` as the reason, and waits for it to close. */
  private async halt(proc: Proc, by: StoppedBy): Promise<void> {
    // A stop while it is still starting waits for the start, then stops it.
    if (proc.spawning !== undefined) await proc.spawning.catch(() => undefined);
    const spawned = proc.spawned;
    if (spawned === undefined || proc.info.status !== "running") return;
    proc.info = { ...proc.info, stoppedBy: by };
    spawned.kill();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      proc.closed,
      new Promise<void>((done) => {
        timer = setTimeout(done, STOP_WAIT_MS);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    // It did not close in time: count it as stopped all the same.
    if (proc.spawned === spawned) {
      proc.spawned = undefined;
      this.ended(proc, null, by);
    }
  }

  /** `quiet`: the caller hears of it directly (a restart that did not start), so nobody is told. */
  private ended(
    proc: Proc,
    code: number | null,
    by: StoppedBy | undefined,
    options: { quiet?: boolean } = {},
  ): void {
    const endedAt = this.now().toISOString();
    proc.info =
      by === undefined
        ? { ...proc.info, status: "exited", exitCode: code, endedAt }
        : { ...proc.info, status: "stopped", stoppedBy: by, endedAt };
    this.changed(proc.info.task, true);
    if (options.quiet !== true) this.deps.onEnded?.(this.view(proc), by === undefined && proc.info.wait);
  }

  /** Drops the oldest ended processes past the ones kept. */
  private prune(task: string): void {
    const procs = this.tasks.get(task);
    if (procs === undefined) return;
    const ended = [...procs.values()].filter((p) => p.info.status !== "running");
    for (const p of ended.slice(0, Math.max(0, ended.length - ENDED_KEPT))) procs.delete(p.info.id);
  }

  /** Tells the room: now for a start, an end or a port, else once per throttle window. */
  private changed(task: string, now: boolean): void {
    const pending = this.timers.get(task);
    if (!now) {
      if (pending !== undefined) return;
      const timer = setTimeout(() => {
        this.timers.delete(task);
        this.emit(task);
      }, this.throttleMs);
      timer.unref();
      this.timers.set(task, timer);
      return;
    }
    if (pending !== undefined) clearTimeout(pending);
    this.timers.delete(task);
    this.emit(task);
  }

  private emit(task: string): void {
    if (!this.tasks.has(task)) return;
    this.deps.onChange?.(task, this.list(task));
  }
}

/**
 * The absolute working directory for `cwd` (relative to the task folder), or a UserError when it
 * is not a folder inside the task folder. Symlinks count by where they lead.
 */
export async function containedCwd(folder: string, cwd: string | undefined): Promise<string> {
  const wanted = resolve(folder, cwd ?? ".");
  const outside = () =>
    new UserError(`${cwd ?? wanted} is outside the task folder. Use a folder inside ${folder}.`);
  if (!inside(wanted, folder)) throw outside();
  let real: string;
  try {
    real = await realpath(wanted);
    if (!(await stat(real)).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new UserError(`${cwd ?? wanted} is not a folder in the task.`);
  }
  if (!inside(real, await realpath(folder))) throw outside();
  return wanted;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
