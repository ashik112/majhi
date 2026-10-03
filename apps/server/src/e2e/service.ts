import type { E2eMode, E2eRun, E2eRunResult, E2eStatus, HostMethod } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import { HostJobError, HostOfflineError } from "../host/link.ts";
import { dayStart, localDay } from "../usage/ranges.ts";
import type { E2eBreak, E2eRepo } from "./repo.ts";

/** How long the suite may take before the helper stops it. */
export const E2E_RUN_TIMEOUT_MS = 90 * 60_000;
/** The call to the helper waits a little longer than the run itself. */
const CALL_SLACK_MS = 60_000;
/** The watcher looks at each project's base branch this often. */
export const E2E_WATCH_MS = 60_000;
const RECENT_RUNS = 10;
const MAX_MERGES_LISTED = 10;

export interface E2eProject {
  id: string;
  org: string;
  /** Absolute path of the checkout, the same on this computer and in the container. */
  path: string;
  base: string | undefined;
  exists: boolean;
}

export interface E2eSchedule {
  /** `e2e.projects`: a project left out is `off`. */
  projects: Record<string, E2eMode>;
  /** `e2e.daily_at`, `HH:MM`. */
  dailyAt: string;
  /** An IANA zone the runtime knows. */
  tz: string;
}

export interface E2eDeps {
  repo: E2eRepo;
  host: {
    isConnected(): boolean;
    call(
      method: Extract<HostMethod, "e2e.run">,
      params: { runId: string; repo: string; commit: string; timeoutMs: number },
      timeoutMs: number,
    ): Promise<E2eRunResult>;
  };
  projects: () => Promise<E2eProject[]>;
  /** The owner's `e2e` settings, with the zone `dailyAt` is in (autonomous mode's, else the server's). */
  settings: () => Promise<E2eSchedule>;
  git: {
    /** The commit the branch is at, or undefined when there is no such branch. */
    tip(path: string, branch: string): Promise<string | undefined>;
    subject(path: string, commit: string): Promise<string | undefined>;
    /** `abbrev subject` of the commits in `from..to`, newest first. */
    between(path: string, from: string, to: string, limit: number): Promise<string[]>;
  };
  /** One line in a task's room. */
  say: (task: string, id: string, level: "info" | "warn", text: string) => void;
  taskExists: (id: string) => boolean;
  createTask: (input: {
    project: string;
    title: string;
    text: string;
    attachments: string[];
  }) => Promise<{ id: string }>;
  /** Stores a trace file the helper kept (relative to the majhi folder) as an upload and returns its id. */
  uploadTrace: (file: string) => Promise<string | undefined>;
  newId: () => string;
  now: () => Date;
  log: (message: string) => void;
  runTimeoutMs?: number;
}

const short = (commit: string): string => commit.slice(0, 7);

function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The task a merge commit came from, read from its subject: `Merge branch 'task/prv-72-...'`. */
export function taskOfSubject(subject: string): string | undefined {
  const m = /task\/([a-z][a-z0-9]*-[1-9][0-9]*)/i.exec(subject);
  return m?.[1]?.toUpperCase();
}

/**
 * Background e2e (PRV-72): runs a project's Playwright suite in the host helper, one run at a time
 * and at low priority. Each project has a mode: `off` (the default), `merge` or `daily`.
 * - In `merge` mode, `onMerged` (majhi's Ship) and `tick` (a merge seen on the branch) queue a run for
 *   a commit. In `daily` mode, `tick` queues one at `daily_at`. `runNow` queues one in any mode. A
 *   newer run replaces a queued run of the same project that has not started.
 * - A finished run is told in the room of the task whose merge triggered it, one quiet line.
 * - A failure opens one task per break: while a break is open, later red runs add a line to its task
 *   and the first green run closes it.
 */
export class E2eService {
  private pumping = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: E2eDeps) {}

  /** Starts the watcher and picks up what a restart left queued or running. */
  start(): void {
    for (const run of this.deps.repo.unfinished()) {
      // The helper's answer to a run that was in flight is lost. Run it again once the helper is free.
      if (run.status === "running") this.deps.repo.setStatus(run.id, "queued");
    }
    const tick = (): void =>
      void this.tick().catch((err: unknown) => this.deps.log(`e2e: ${errorMessage(err)}`));
    tick();
    this.timer = setInterval(tick, E2E_WATCH_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** When the suite runs for this project. Every project is `off` until the owner picks a mode. */
  private static modeOf(schedule: E2eSchedule, project: string): E2eMode {
    return schedule.projects[project] ?? "off";
  }

  /** majhi merged `task` into `into` of a project. Queues a run at the base branch's new tip in `merge` mode. */
  async onMerged(input: { project: string; task: string; into: string }): Promise<void> {
    const project = (await this.deps.projects()).find((p) => p.id === input.project);
    if (project === undefined || project.base === undefined || !project.exists) return;
    if (input.into !== project.base) return;
    if (E2eService.modeOf(await this.deps.settings(), project.id) !== "merge") return;
    const tip = await this.deps.git.tip(project.path, project.base);
    if (tip === undefined) return;
    this.deps.repo.setSeen(project.id, tip, this.deps.now().toISOString());
    await this.enqueue(project, tip, input.task);
  }

  /**
   * Every minute: in `merge` mode, a base tip that moved since the last look is a merge majhi did not
   * do itself; in `daily` mode, the day's run is due once the owner's clock passes `daily_at`.
   */
  async tick(): Promise<void> {
    const schedule = await this.deps.settings();
    for (const project of await this.deps.projects()) {
      if (project.base === undefined || !project.exists) continue;
      const mode = E2eService.modeOf(schedule, project.id);
      if (mode === "merge") await this.watchMerges(project, project.base);
      else if (mode === "daily") await this.daily(project, project.base, schedule);
    }
    void this.pump();
  }

  private async watchMerges(project: E2eProject, base: string): Promise<void> {
    const tip = await this.deps.git.tip(project.path, base);
    if (tip === undefined) return;
    const seen = this.deps.repo.seen(project.id);
    this.deps.repo.setSeen(project.id, tip, this.deps.now().toISOString());
    // The first sight of a project is a baseline, not a merge.
    if (seen === undefined || seen === tip) return;
    const subject = await this.deps.git.subject(project.path, tip);
    const task = subject === undefined ? undefined : taskOfSubject(subject);
    await this.enqueue(project, tip, task !== undefined && this.deps.taskExists(task) ? task : undefined);
  }

  /**
   * Once a day, after `daily_at` in the owner's zone: a run at the base tip, unless a run of the
   * project was queued since then today, or the last finished run was already at this tip.
   */
  private async daily(project: E2eProject, base: string, schedule: E2eSchedule): Promise<void> {
    const now = this.deps.now();
    const [h = 0, m = 0] = schedule.dailyAt.split(":").map(Number);
    const due = new Date(dayStart(localDay(now, schedule.tz), schedule.tz).getTime() + (h * 60 + m) * 60_000);
    if (now.getTime() < due.getTime()) return;
    if (this.deps.repo.queuedSince(project.id, due.toISOString())) return;
    const tip = await this.deps.git.tip(project.path, base);
    if (tip === undefined) return;
    if (this.deps.repo.lastFinished(project.id)?.commit === tip) return;
    await this.enqueue(project, tip, undefined);
  }

  /**
   * The owner's Run now: a run at the base tip whatever the mode. A run at that commit that is queued
   * or running already is the answer; a finished one is run again.
   */
  async runNow(id: string): Promise<{ run: E2eRun; queued: boolean }> {
    const project = (await this.deps.projects()).find((p) => p.id === id);
    if (project === undefined) throw new UserError(`There is no project ${id}.`, 404);
    if (!project.exists) throw new UserError(`The checkout of ${id} is missing.`, 409);
    if (project.base === undefined) throw new UserError(`${id} has no base branch.`, 409);
    const tip = await this.deps.git.tip(project.path, project.base);
    if (tip === undefined) throw new UserError(`${id} has no branch ${project.base}.`, 409);
    const running = this.deps.repo.running();
    const active = [...(running === undefined ? [] : [running]), ...this.deps.repo.queued()].find(
      (r) => r.project === id && r.commit === tip,
    );
    if (active !== undefined) return { run: active, queued: false };
    const runId = await this.queue(project, tip, undefined);
    const run = this.deps.repo.getRun(runId);
    if (run === undefined) throw new Error(`e2e run ${runId} was not stored`);
    return { run, queued: true };
  }

  private async enqueue(project: E2eProject, commit: string, task: string | undefined): Promise<void> {
    if (this.deps.repo.runAt(project.id, commit) !== undefined) return;
    await this.queue(project, commit, task);
  }

  /** Inserts a queued run and returns its id. */
  private async queue(project: E2eProject, commit: string, task: string | undefined): Promise<string> {
    const now = this.deps.now().toISOString();
    // A newer run takes the place of one of the same project that has not started.
    const id = this.deps.newId();
    for (const queued of this.deps.repo.queued()) {
      if (queued.project !== project.id) continue;
      this.deps.repo.setStatus(queued.id, "replaced", { at: now });
      if (queued.task !== undefined && this.deps.taskExists(queued.task)) {
        this.deps.say(
          queued.task,
          `e2e:${queued.id}`,
          "info",
          `Background e2e at ${short(queued.commit)} did not start: ${short(commit)} replaced it, and covers it.`,
        );
      }
    }
    const subject = await this.deps.git.subject(project.path, commit);
    this.deps.repo.insertRun({
      id,
      project: project.id,
      commit,
      ...(subject === undefined ? {} : { subject }),
      ...(task === undefined ? {} : { task }),
      at: now,
    });
    void this.pump();
    return id;
  }

  /** Runs queued runs one after another. Does nothing while one runs or the helper is away. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const next = this.deps.repo.queued()[0];
        if (next === undefined || !this.deps.host.isConnected()) return;
        if (!(await this.runOne(next))) return;
      }
    } finally {
      this.pumping = false;
    }
  }

  /** False when the run went back to the queue, so the loop stops and the next tick tries again. */
  private async runOne(run: E2eRun): Promise<boolean> {
    const project = (await this.deps.projects()).find((p) => p.id === run.project);
    const now = (): string => this.deps.now().toISOString();
    if (project === undefined) {
      this.deps.repo.setStatus(run.id, "errored", {
        at: now(),
        error: "The project is no longer registered.",
      });
      return true;
    }
    this.deps.repo.setStatus(run.id, "running", { at: now() });
    const timeoutMs = this.deps.runTimeoutMs ?? E2E_RUN_TIMEOUT_MS;
    let result: E2eRunResult;
    try {
      result = await this.deps.host.call(
        "e2e.run",
        { runId: run.id, repo: project.path, commit: run.commit, timeoutMs },
        timeoutMs + CALL_SLACK_MS,
      );
    } catch (err) {
      if (err instanceof HostJobError && /already in progress/.test(err.message)) {
        this.deps.repo.setStatus(run.id, "queued");
        return false;
      }
      if (err instanceof HostOfflineError && !this.deps.host.isConnected()) {
        this.deps.repo.setStatus(run.id, "queued");
        return false;
      }
      const error =
        err instanceof HostJobError || err instanceof HostOfflineError ? err.message : errorMessage(err);
      result = {
        outcome: "errored",
        durationMs: 0,
        passed: 0,
        failed: 0,
        failedSpecs: [],
        traces: [],
        error,
      };
    }
    await this.complete(run, project, result);
    return true;
  }

  private async complete(run: E2eRun, project: E2eProject, result: E2eRunResult): Promise<void> {
    const { repo } = this.deps;
    const at = this.deps.now().toISOString();
    repo.finish(run.id, {
      status: result.outcome,
      at,
      durationMs: result.durationMs,
      passed: result.passed,
      failed: result.failed,
      failedSpecs: result.failedSpecs,
      traces: result.traces,
      error: result.error,
    });
    const where = `${project.id} at ${short(run.commit)}`;
    const open = repo.openBreak(project.id);
    const openTask = open !== undefined && this.deps.taskExists(open.task) ? open : undefined;
    let line: string;
    let level: "info" | "warn" = "info";
    if (result.outcome === "passed") {
      line = `Background e2e on ${where}: passed (${result.passed} tests, ${duration(result.durationMs)}).`;
      if (open !== undefined) {
        repo.closeBreak(open.id, at);
        if (openTask !== undefined) {
          this.deps.say(
            openTask.task,
            `e2e-green:${run.id}`,
            "info",
            `Background e2e is green again at ${short(run.commit)}.`,
          );
        }
      }
    } else if (result.outcome === "errored") {
      level = "warn";
      line = `Background e2e on ${where} could not run: ${result.error ?? "unknown error"}`;
    } else {
      level = "warn";
      const named = `${result.failed} failing test${result.failed === 1 ? "" : "s"}`;
      const opened = await this.breakTask(run, project, result, openTask);
      line = `Background e2e on ${where}: failed, ${named} in ${duration(result.durationMs)}. ${
        opened === undefined ? "" : `Fix task ${opened}.`
      }`.trim();
      if (opened !== undefined) repo.setBreakTask(run.id, opened);
    }
    if (run.task !== undefined && this.deps.taskExists(run.task)) {
      this.deps.say(run.task, `e2e:${run.id}`, level, line);
    }
  }

  /** The task of this break: the open one, or a new one with the specs, the merges and the traces. */
  private async breakTask(
    run: E2eRun,
    project: E2eProject,
    result: E2eRunResult,
    open: E2eBreak | undefined,
  ): Promise<string | undefined> {
    if (open !== undefined) {
      this.deps.say(
        open.task,
        `e2e-red:${run.id}`,
        "warn",
        `Background e2e is still red at ${short(run.commit)}: ${result.failed} failing test${result.failed === 1 ? "" : "s"}.`,
      );
      return open.task;
    }
    const lastGreen = this.deps.repo.lastGreen(project.id);
    let merges: string[] = [];
    if (lastGreen !== undefined) {
      merges = await this.deps.git
        .between(project.path, lastGreen, run.commit, MAX_MERGES_LISTED)
        .catch(() => []);
    }
    const attachments: string[] = [];
    for (const trace of result.traces) {
      const id = await this.deps.uploadTrace(trace.file).catch(() => undefined);
      if (id !== undefined) attachments.push(id);
    }
    const first = result.failedSpecs[0] ?? "the suite";
    const text = [
      `Background e2e failed on ${project.base ?? "main"} of ${project.id} at ${run.commit}${run.subject === undefined ? "" : ` (${run.subject})`}.`,
      run.task === undefined ? "" : `The merge that triggered the run: ${run.task}.`,
      "",
      `Failing specs (${result.failed}):`,
      ...result.failedSpecs.map((s) => `- ${s}`),
      "",
      lastGreen === undefined
        ? "Last green commit: none recorded yet."
        : `Last green commit: ${lastGreen}. Commits since then, newest first, one of them broke it:`,
      ...merges.map((m) => `- ${m}`),
      "",
      attachments.length === 0
        ? "No Playwright trace could be attached."
        : `Playwright traces of the failures are attached (${attachments.length}). Open one with \`pnpm exec playwright show-trace <file>\`.`,
      "",
      "Fix the break. Do not run the whole suite: majhi runs it in the background. Read the latest result with the e2e_latest tool.",
    ]
      .filter((l, i, all) => l !== "" || all[i - 1] !== "")
      .join("\n");
    const title = `Fix e2e break on ${project.base ?? "main"}: ${first.split(" > ")[0] ?? first}`;
    const task = await this.deps.createTask({ project: project.id, title, text, attachments });
    this.deps.repo.insertBreak({
      project: project.id,
      task: task.id,
      firstRun: run.id,
      firstCommit: run.commit,
      ...(lastGreen === undefined ? {} : { lastGreen }),
      openedAt: this.deps.now().toISOString(),
    });
    return task.id;
  }

  async status(): Promise<E2eStatus> {
    const projects = await this.deps.projects();
    const schedule = await this.deps.settings();
    const running = this.deps.repo.running();
    return {
      projects: projects.map((p) => ({ id: p.id, mode: E2eService.modeOf(schedule, p.id) })),
      dailyAt: schedule.dailyAt,
      tz: schedule.tz,
      ...(running === undefined ? {} : { running }),
      queued: this.deps.repo.queued(),
      latest: this.deps.repo.latestPerProject(),
      recent: this.deps.repo.recent(RECENT_RUNS),
    };
  }
}
