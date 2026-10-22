import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunMount } from "@majhi/acp";
import { isId, PRIVATE, type Task } from "@majhi/shared";
import { z } from "zod";
import type { CiCommand } from "../ci/jobs.ts";
import { parseShell } from "../ci/shell.ts";
import { errorMessage } from "../errors.ts";
import { buildScript, inputFiles, PYTHON_LINE, STEP, sourceOf } from "./build.ts";
import { type PlanFiles, type PythonPlan, planPython } from "./python.ts";

/**
 * One environment per project, built once and used by every task of the project (docs/DECISIONS.md, 2026-10-22).
 * A code task whose project has a check or test command starts its agent only when the project's dependencies
 * are installed: the environment is a folder (`<majhi home>/envs/<org>/<project>/<key>`), made by the runner,
 * that a task mounts read-only at the same path, with its interpreter first on PATH. The key names what the
 * environment is made from (the project's install files, the system packages and the runner image), so a
 * second task with the same files finds it ready and builds nothing, and a changed requirements file or a
 * new runner image builds another. `ready.json` is the one record: written last, so a folder without it is a
 * build that did not finish. One build runs at a time on this computer, in the order they were asked.
 */

const BUILD_TIMEOUT_MS = 30 * 60_000;
/** Environments kept per project: the newest, and the one before it for tasks that started on it. */
const KEPT = 2;
const TAIL_LINES = 15;
const TAIL_CHARS = 1_500;
const PLAN_VERSION = 1;

const RelPath = z
  .string()
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "A folder inside");
const ReadySchema = z.strictObject({
  version: z.literal(PLAN_VERSION),
  key: z.string().min(1),
  project: z.string().min(1),
  python: z.string().min(1),
  at: z.string().min(1),
  /** Where it came from, for the owner. */
  from: z.string(),
  system: z.array(z.string()),
  skipped: z.array(z.string()),
  /** Folders of the environment (relative) that hold its programs and its shared libraries. */
  bin: z.array(RelPath),
  libs: z.array(RelPath),
});
export type Ready = z.infer<typeof ReadySchema>;

/** The result of a build run in the runner. */
export interface BuildResult {
  code: number | null;
  timedOut: boolean;
  output: string;
  /** majhi could not start it. */
  error?: string | undefined;
}

/** Runs a shell script in a task's runner with `mounts` besides the task's own. */
export type BuildExec = (
  task: string,
  cwd: string,
  script: string,
  timeoutMs: number,
  mounts: RunMount[],
) => Promise<BuildResult>;

export interface ProjectEnvDeps {
  majhiHome: string;
  /** Names the runner image the environment is built in: a new runner image makes every environment build again. */
  runnerKey: () => Promise<string>;
  task: (id: string) => Task | undefined;
  files: (worktree: string) => PlanFiles;
  ci: (worktree: string) => Promise<CiCommand[]>;
  /** What the project's own commands are: whether it has a check, the folders they run in, the card's install line. */
  project: (
    project: string,
    worktree: string,
  ) => Promise<{ checks: boolean; dirs: string[]; installLine?: string | undefined }>;
  exec: BuildExec;
  now?: () => number;
}

/** What a run of a task gets from the project's environment. */
export interface EnvFacts {
  project: string;
  /** The environment folder, mounted read-only at this path. */
  dir: string;
  mounts: RunMount[];
  env: Record<string, string>;
  /** The line TASK.md says, with the interpreter's place. */
  line: string;
}

/** What a task waits for before its agent starts: see `ProjectEnvs.ensure`. */
export interface EnvGate {
  has: boolean;
  waiting: boolean;
  done: Promise<EnvFailure | undefined>;
}

/** A build that failed: one line for the room and the text of the card, which carries the end of the log. */
export interface EnvFailure {
  project: string;
  step: string;
  line: string;
  card: string;
}

/**
 * What every environment of a task adds to a run, as one set of mounts and variables: the first project's
 * interpreter wins `VIRTUAL_ENV`, and the program and library folders of all of them are listed in order.
 */
export function combineFacts(list: readonly EnvFacts[]): { mounts: RunMount[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const join = (name: string, value: string | undefined) => {
    if (value === undefined || value === "") return;
    env[name] = env[name] === undefined ? value : `${env[name]}:${value}`;
  };
  for (const f of list) {
    env.VIRTUAL_ENV ??= f.env.VIRTUAL_ENV ?? "";
    join("MAJHI_ENV_PATH", f.env.MAJHI_ENV_PATH);
    join("LD_LIBRARY_PATH", f.env.LD_LIBRARY_PATH);
    join("PYTHONPATH", f.env.PYTHONPATH);
  }
  return { mounts: list.flatMap((f) => f.mounts), env };
}

/** `Preparing the project's environment (2:14)`. */
export function preparingLine(sinceMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  const rest = String(seconds % 60).padStart(2, "0");
  return `Preparing the project's environment (${Math.floor(seconds / 60)}:${rest})`;
}

interface Planned {
  project: string;
  worktree: string;
  plan: PythonPlan;
  dir: string;
  key: string;
}

type Outcome = { ok: true } | { ok: false; step: string; tail: string };

export class ProjectEnvs {
  /** Builds in flight, by environment folder: a second task that needs the same one waits for it. */
  private readonly inflight = new Map<string, Promise<Outcome>>();
  /** The one build that runs at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  /** The environment each task started on, by `task/project`: its edits to a requirements file do not move it. */
  private readonly bound = new Map<string, { task: string; key: string }>();

  constructor(private readonly deps: ProjectEnvDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private orgOf(task: Task): string {
    return task.org ?? PRIVATE;
  }

  private projectRoot(org: string, project: string): string | undefined {
    return isId(org) && isId(project) ? join(this.deps.majhiHome, "envs", org, project) : undefined;
  }

  private keyOf(plan: PythonPlan, runner: string): string {
    const text = JSON.stringify({ v: PLAN_VERSION, runner, plan });
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  }

  /** The environments a task needs: one per repo that has a check or test command and an install majhi can read. */
  private async planned(task: Task): Promise<Planned[]> {
    if (task.kind !== "code") return [];
    const out: Planned[] = [];
    for (const repo of task.repos) {
      const worktree = repo.worktree;
      const root = this.projectRoot(this.orgOf(task), repo.project);
      if (worktree === undefined || root === undefined) continue;
      const info = await this.deps.project(repo.project, worktree);
      if (!info.checks) continue;
      const plan = await planPython(this.deps.files(worktree), {
        commands: await this.deps.ci(worktree).catch(() => []),
        installLine: info.installLine,
        checkDirs: info.dirs,
        words: (line) => {
          const parsed = parseShell(line);
          return parsed.ok ? parsed.segments.map((s) => s.argv) : [];
        },
      });
      if (plan === undefined) continue;
      const key = this.keyOf(plan, await this.deps.runnerKey());
      out.push({ project: repo.project, worktree, plan, dir: join(root, key), key });
    }
    return out;
  }

  private async readReady(dir: string): Promise<Ready | undefined> {
    try {
      const parsed = ReadySchema.safeParse(JSON.parse(await readFile(join(dir, "ready.json"), "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Starts what the task's projects still lack and says whether the task must wait. `done` settles when every
   * environment it needs is ready (undefined) or one failed (the failure). `has` is true when the task has an
   * environment at all, ready or not. A task whose projects have no check, or no install majhi can read,
   * waits for nothing and has none.
   */
  async ensure(taskId: string): Promise<EnvGate> {
    const task = this.deps.task(taskId);
    if (task === undefined) return { has: false, waiting: false, done: Promise.resolve(undefined) };
    const planned = await this.planned(task);
    const waits: Promise<EnvFailure | undefined>[] = [];
    for (const p of planned) {
      this.bound.set(`${taskId}/${p.project}`, { task: taskId, key: p.key });
      if ((await this.readReady(p.dir)) !== undefined) continue;
      waits.push(
        this.build(p, taskId).then((outcome) => (outcome.ok ? undefined : failureOf(p.project, outcome))),
      );
    }
    const has = planned.length > 0;
    if (waits.length === 0) return { has, waiting: false, done: Promise.resolve(undefined) };
    return {
      has,
      waiting: true,
      done: Promise.all(waits).then((results) => results.find((r) => r !== undefined)),
    };
  }

  /** The environments a run of the task gets: mounts, variables and the line TASK.md says. Empty when none is ready. */
  async facts(taskId: string): Promise<EnvFacts[]> {
    const task = this.deps.task(taskId);
    if (task === undefined || task.kind !== "code") return [];
    const out: EnvFacts[] = [];
    for (const repo of task.repos) {
      const root = this.projectRoot(this.orgOf(task), repo.project);
      if (root === undefined) continue;
      const key = this.bound.get(`${taskId}/${repo.project}`)?.key;
      const found =
        key === undefined ? await this.newest(root) : await this.withKey(root, key).catch(() => undefined);
      if (found === undefined) continue;
      out.push(factsOf(repo.project, found.dir, found.ready, task.folder));
    }
    return out;
  }

  private async withKey(root: string, key: string): Promise<{ dir: string; ready: Ready } | undefined> {
    const dir = join(root, key);
    const ready = await this.readReady(dir);
    return ready === undefined ? undefined : { dir, ready };
  }

  /** The newest ready environment of a project: for a task that started before majhi restarted. */
  private async newest(root: string): Promise<{ dir: string; ready: Ready } | undefined> {
    const all = await this.readyIn(root);
    return all.toSorted((a, b) => b.ready.at.localeCompare(a.ready.at))[0];
  }

  private async readyIn(root: string): Promise<{ dir: string; ready: Ready }[]> {
    const names = await readdir(root).catch(() => [] as string[]);
    const found: { dir: string; ready: Ready }[] = [];
    for (const name of names) {
      const dir = join(root, name);
      const ready = await this.readReady(dir);
      if (ready !== undefined) found.push({ dir, ready });
    }
    return found;
  }

  private build(p: Planned, taskId: string): Promise<Outcome> {
    const running = this.inflight.get(p.dir);
    if (running !== undefined) return running;
    // One build at a time: this one starts when the ones asked before it end, however they end.
    const turn = this.chain.then(
      () => this.run(p, taskId),
      () => this.run(p, taskId),
    );
    this.chain = turn;
    this.inflight.set(p.dir, turn);
    void turn.finally(() => this.inflight.delete(p.dir)).catch(() => undefined);
    return turn;
  }

  private async run(p: Planned, taskId: string): Promise<Outcome> {
    // Another task's build may have made it while this one waited its turn.
    if ((await this.readReady(p.dir)) !== undefined) return { ok: true };
    try {
      await rm(p.dir, { recursive: true, force: true });
      await mkdir(join(p.dir, "inputs"), { recursive: true });
      for (const [name, text] of Object.entries(inputFiles(p.plan))) {
        await writeFile(join(p.dir, "inputs", name), text);
      }
    } catch (err) {
      return { ok: false, step: "Making the folder", tail: errorMessage(err) };
    }
    const result: BuildResult = await this.deps
      .exec(taskId, p.worktree, buildScript(p.plan, p.dir, sourceOf(p.worktree, p.plan)), BUILD_TIMEOUT_MS, [
        { path: p.dir },
      ])
      .catch((err: unknown) => ({ code: null, timedOut: false, output: "", error: errorMessage(err) }));
    const output = result.output;
    const python = output
      .split("\n")
      .find((l) => l.startsWith(PYTHON_LINE))
      ?.slice(PYTHON_LINE.length)
      .trim();
    if (result.error !== undefined || result.code !== 0 || python === undefined) {
      await rm(p.dir, { recursive: true, force: true }).catch(() => undefined);
      const step =
        lastStep(output) ?? (result.error === undefined ? "Starting the build" : "Starting the runner");
      const why = result.timedOut
        ? "It did not finish in 30 minutes."
        : result.error !== undefined
          ? result.error
          : tailOf(output);
      return { ok: false, step, tail: why };
    }
    try {
      await writeFile(join(p.dir, "ready.json"), JSON.stringify(await this.record(p, python)));
    } catch (err) {
      await rm(p.dir, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, step: "Saving the environment", tail: errorMessage(err) };
    }
    void this.prune(p.dir).catch(() => undefined);
    return { ok: true };
  }

  private async record(p: Planned, python: string): Promise<Ready> {
    const bin = ["venv/bin"];
    const libs: string[] = [];
    if (p.plan.system.length > 0) {
      bin.push("sysroot/usr/bin");
      libs.push("sysroot/usr/lib");
      const lib = join(p.dir, "sysroot", "usr", "lib");
      for (const name of await readdir(lib).catch(() => [] as string[])) {
        if (name.endsWith("-linux-gnu")) libs.push(`sysroot/usr/lib/${name}`);
      }
    }
    return {
      version: PLAN_VERSION,
      key: p.key,
      project: p.project,
      python,
      at: new Date(this.now()).toISOString(),
      from: p.plan.from,
      system: p.plan.system,
      skipped: p.plan.installs.flatMap((i) => (i.kind === "pip" ? i.skipped : [])),
      bin,
      libs,
    };
  }

  /** Removes the older environments of the project: the newest `KEPT` stay, and so does any a task started on. */
  private async prune(dir: string): Promise<void> {
    const root = join(dir, "..");
    // A task that is done no longer holds its environment.
    const inUse = new Set(
      [...this.bound.values()].filter((b) => this.deps.task(b.task)?.status !== "done").map((b) => b.key),
    );
    const names = new Set(await readdir(root).catch(() => [] as string[]));
    const ready = (await this.readyIn(root)).toSorted((a, b) => b.ready.at.localeCompare(a.ready.at));
    const keep = new Set(ready.slice(0, KEPT).map((r) => r.ready.key));
    for (const name of names) {
      const path = join(root, name);
      if (keep.has(name) || inUse.has(name) || this.inflight.has(path)) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * The environment is read-only and shared, so a package a task adds goes in a folder of its own beside its
 * repos (never in git), which is on `PYTHONPATH`.
 */
const EXTRA_PACKAGES = ".pydeps";

function factsOf(project: string, dir: string, ready: Ready, taskFolder: string): EnvFacts {
  const abs = (rel: string) => join(dir, rel);
  const venv = abs("venv");
  const libs = ready.libs.map(abs);
  const extra = join(taskFolder, EXTRA_PACKAGES);
  return {
    project,
    dir,
    mounts: [{ path: dir, readOnly: true }],
    env: {
      VIRTUAL_ENV: venv,
      MAJHI_ENV_PATH: ready.bin.map(abs).join(":"),
      PYTHONPATH: extra,
      ...(libs.length === 0 ? {} : { LD_LIBRARY_PATH: libs.join(":") }),
    },
    line: `Environment ready: Python ${ready.python} in ${venv} (first on PATH, read-only). The project's dependencies are installed there: do not install them yourself.\n  A package this task adds: \`pip install --target ${extra} <package>\` (already on PYTHONPATH), and write it in the requirements file.`,
  };
}

/** The text after the last `==> ` line of a build's output: the step it was in. */
function lastStep(output: string): string | undefined {
  const steps = output.split("\n").filter((l) => l.startsWith(STEP));
  const last = steps.at(-1);
  return last === undefined ? undefined : last.slice(STEP.length).trim();
}

function tailOf(output: string): string {
  const lines = output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  return lines.length > TAIL_CHARS ? lines.slice(-TAIL_CHARS) : lines;
}

function failureOf(project: string, outcome: Extract<Outcome, { ok: false }>): EnvFailure {
  const line = `The environment of ${project} could not be built: ${outcome.step} failed.`;
  return {
    project,
    step: outcome.step,
    line,
    // The card shows this as markdown: the log goes in a fence, so its lines stay lines.
    card: `${line} The end of the log:\n\n\`\`\`\n${outcome.tail.split("```").join("'''")}\n\`\`\`\n\nResume the task to try again.`,
  };
}
