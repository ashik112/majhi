import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  HANDOFF_STRIKES,
  type HandoffActivity,
  type HandoffCommandStep,
  type HandoffFailed,
  type HandoffHistoryItem,
  type HandoffRan,
  type HandoffResult,
  type HandoffReview,
  type HandoffState,
  type HandoffStep,
  type HandoffStepId,
  handoffSeconds,
  handoffSummary,
} from "@majhi/shared";
import type { CiService } from "../ci/jobs.ts";
import { safeLine } from "../ci/safe.ts";
import { errorMessage, UserError } from "../errors.ts";
import {
  acceptanceLines,
  changedLines,
  type DiffFacts,
  failureNote,
  freeReview,
  isDocsOnly,
  matchAcceptance,
  outputTail,
  passedCount,
  patchBudget,
  rerunNote,
  reviewPrompt,
  TRIVIAL_LINES,
} from "./analysis.ts";
import type { Checkout } from "./checkout.ts";
import { substituteBase, usesBase } from "./commands.ts";
import { impliedMemoryMb, memoryMb, sizeWords } from "./limits.ts";
import { logPath, newRunId, StepLog } from "./logs.ts";
import { compareFailures, type ProblemKind, problemsOf } from "./problems.ts";
import type { DeepRow, HandoffRepo } from "./repo.ts";
import { startServices } from "./services.ts";

/**
 * The checked hand-off (SPEC 5.18, captain v2 step 7). A task that says it is done is verified
 * before anyone sees "Ready to ship": cheap checks in code, the project card's tests, build and lint
 * in the task's own worktree, the brief's acceptance lines, and a small review that only adds notes.
 * A red check goes back to the lead once per head commit; the third failed hand-off in a row goes to
 * the owner. The costly part is cached by head, so the same head is never run twice.
 */

export interface HandoffTask {
  id: string;
  title: string;
  brief: string;
  org: string;
  status: string;
  repos: { project: string; worktree?: string | undefined }[];
}

export type ReadyResult =
  | { ok: true; evidence: string }
  /** `owner`: only the owner can clear it (a card waits, a protected repo), so the lead is not told. */
  | { ok: false; why: string; owner?: boolean; empty?: undefined }
  /** No repo changed since the task started: there is nothing to check or ship, which is not a failure. */
  | { ok: false; why: string; empty: true; owner?: undefined };

export interface ExecResult {
  /** The exit code, or null when it was killed. */
  code: number | null;
  timedOut: boolean;
  /** The end of what it printed, secrets masked. */
  output: string;
  /** What it printed, whole up to the log cap, secrets masked. */
  log: string;
  /** Characters left out of the middle of `log` when it passed the cap. */
  cut?: number | undefined;
  ms: number;
  /** majhi could not start it (no runner, no agent to run it as): not the lead's fault. */
  error?: string | undefined;
}

/** What a hand-off check may use: its own caps, not an agent run's. */
export interface ExecLimits {
  cpus: number;
  memory: string;
}

/** The hand-off settings of a project: caps, and the minutes its tests and build may take (undefined: the default). */
export interface HandoffLimits extends ExecLimits {
  /** The owner set the memory limit (for the workspace or majhi-wide). Then it is a ceiling the CI's own needs do not raise. */
  memorySet?: boolean | undefined;
  /** The most a check may be given without a limit set: what the machine can spare, like `12g`. */
  memoryCeiling?: string | undefined;
  /** The project's own minutes for its tests and build. They win over `stepMinutes`. */
  minutes: number | undefined;
  /** The minutes each step may take, from settings. A step left out gets its default. */
  stepMinutes?: { [K in HandoffCommandStep]?: number | undefined } | undefined;
}

export interface CardCommands {
  install?: string | undefined;
  test?: string | undefined;
  build?: string | undefined;
  lint?: string | undefined;
  typecheck?: string | undefined;
}

/** One check as the project defines it: the line, the environment and folder it runs in, and where it came from. */
export interface CheckSpec {
  command: string;
  env: Record<string, string>;
  /** Relative to the repo root. Absent: the root. */
  workdir?: string | undefined;
  /** "from .gitlab-ci.yml job build", "set for this project", "from the project card". */
  from: string;
  /** The minutes the CI gives the job. */
  minutes?: number | undefined;
  /** The services the CI job starts next to the check: started for it, removed after. */
  services?: CiService[] | undefined;
}

/** What a check did on the base commit: kept by the base, the check and its environment. */
export interface BaseRun {
  passed: boolean;
  /** The problems it reported, when they were understood. */
  problems?: string[] | undefined;
}

export interface HandoffPorts {
  task(id: string): HandoffTask | undefined;
  /** The task's head commits, one per repo (`project@sha`). */
  heads(id: string): Promise<string>;
  /** Committed, merges cleanly, no card waits, no secret in the diff: the cheap checks, live. */
  ready(id: string): Promise<ReadyResult>;
  /** The test, build and lint commands the check runs for a project: its own override, else its card's. */
  commands(project: string): CardCommands | Promise<CardCommands>;
  /** The merge-base commit of a task's branch and its target in one project, as majhi computed it. */
  mergeBase?(task: string, project: string): Promise<string | undefined>;
  diff(id: string): Promise<DiffFacts>;
  /** Whether a worktree lacks the packages its project installs (no `node_modules`, no virtualenv). Absent: never. */
  needsInstall?(cwd: string): Promise<boolean>;
  /** Saves one step's whole output as a file in the task folder (`logPath(run, step)`). Rejects when it cannot. */
  saveLog?(task: string, run: string, step: HandoffStepId, text: string): Promise<void>;
  /**
   * The check of one kind for a project, from its own setting, else its CI, else its card. Absent: the
   * card's commands (`commands`).
   */
  checkSpec?(
    task: string,
    project: string,
    kind: HandoffCommandStep,
    worktree: string,
  ): Promise<CheckSpec | undefined>;
  /** The body of a package.json script in a folder, for turning a script that writes into its read-only form. */
  script?(cwd: string, name: string): Promise<string | undefined>;
  /**
   * A throwaway checkout of a commit, with the worktree's installed packages linked in (none when `installedFrom` is absent). Absent: checks
   * run in the worktree itself.
   */
  checkout?(
    task: string,
    project: string,
    commit: string,
    installedFrom: string | undefined,
  ): Promise<Checkout>;
  /** The commit the task's branch is at in one project. */
  headCommit?(task: string, project: string): Promise<string | undefined>;
  /**
   * Whether the task changed what a project installs (a manifest or a lockfile) between `base` and its head. A base
   * copy then gets its own install: the packages of the head are not the base's.
   */
  dependenciesChanged?(task: string, project: string, base: string): Promise<boolean>;
  /** What the same check did on a base commit, kept by `key` (the base, the check, its environment). */
  baseRuns?: {
    get(key: string): Promise<BaseRun | undefined>;
    put(key: string, run: BaseRun): Promise<void>;
  };
  /** Files a finding for a check that fails on the base, once per project and check. Returns its id. */
  reportExisting?(input: {
    task: string;
    project: string;
    kind: HandoffCommandStep;
    command: string;
    base: string;
    problems: string[];
    tail: string;
  }): Promise<number | undefined>;
  /** Runs one shell line in a task's worktree, in its runner, with a timeout. */
  exec(
    task: string,
    cwd: string,
    command: string,
    timeoutMs: number,
    limits?: ExecLimits,
    env?: Record<string, string>,
  ): Promise<ExecResult>;
  /** The caps and timeout settings of a project's checks. Absent: majhi's defaults. */
  limits?(project: string): Promise<HandoffLimits>;
  /** What the check ran in: majhi's commit and the runner image. A failure is tried again when it changes. */
  environment?(): string;
  /** The smallest capable model reads the prompt. Rejects when none can. */
  review(task: { id: string; org: string }, prompt: string): Promise<{ gaps: string[]; tokens: number }>;
  /** Autonomous is on: the captain may send a lead back to work and spend on a review. */
  autonomous(): boolean;
  /** The owner switched an outcome rule of Ship finished work off in the task's workspace (`ship-checks`). */
  ruleOff?(org: string, rule: string): boolean;
  /** Why the model may not be used now (the monthly ceiling), or undefined. */
  modelBlocked(org: string): string | undefined;
  /** Writes to the task's lead as majhi's check. Rejects when the task has no lead to tell. */
  tell(id: string, text: string, failed?: HandoffFailed): Promise<void>;
  /** Puts a line on the task's review card for the owner, or clears the check's line. */
  hold(id: string, line: string | undefined): void;
  changed(id: string): void;
  now?: () => Date;
}

export interface HandoffOptions {
  testMs?: number;
  buildMs?: number;
  lintMs?: number;
  typecheckMs?: number;
  installMs?: number;
  /** Checks that run at once across majhi, and per workspace. They take no agent slot: no agent runs. */
  parallel?: number;
  perOrg?: number;
}

const MINUTE = 60_000;
/** A failed check of one head runs at most this many times in all. */
export const MAX_ATTEMPTS = 3;
/** A failed check this old runs again even when nothing changed. */
const RETRY_AFTER_MS = 6 * 60 * MINUTE;
export const TEST_TIMEOUT_MS = 10 * MINUTE;
export const BUILD_TIMEOUT_MS = 10 * MINUTE;
export const LINT_TIMEOUT_MS = 5 * MINUTE;
export const INSTALL_TIMEOUT_MS = 10 * MINUTE;

/** Keeps at most `limit` running and `perOrg` per workspace, in the order they asked. */
class Slots {
  private running = 0;
  private readonly orgs = new Map<string, number>();
  private readonly waiting: { org: string; go: () => void }[] = [];
  constructor(
    private readonly limit: number,
    private readonly perOrg: number,
  ) {}

  private fits(org: string): boolean {
    return this.running < this.limit && (this.orgs.get(org) ?? 0) < this.perOrg;
  }

  private take(org: string): void {
    this.running++;
    this.orgs.set(org, (this.orgs.get(org) ?? 0) + 1);
  }

  async run<T>(org: string, work: () => Promise<T>): Promise<T> {
    if (this.fits(org)) this.take(org);
    else await new Promise<void>((go) => this.waiting.push({ org, go }));
    try {
      return await work();
    } finally {
      this.running--;
      this.orgs.set(org, (this.orgs.get(org) ?? 1) - 1);
      // The oldest waiting start that fits goes: a full workspace does not hold up another.
      const next = this.waiting.findIndex((w) => this.fits(w.org));
      if (next >= 0) {
        const [w] = this.waiting.splice(next, 1);
        if (w !== undefined) {
          this.take(w.org);
          w.go();
        }
      }
    }
  }
}

/** The step labels, as the card shows them. */
const LABEL: Record<HandoffStepId, string> = {
  ready: "Merge checks",
  install: "Install",
  tests: "Tests",
  build: "Build",
  lint: "Lint",
  typecheck: "Types",
  acceptance: "Brief",
  review: "Review",
};

const step = (id: HandoffStepId, rest: Omit<HandoffStep, "id" | "label">): HandoffStep => ({
  id,
  label: LABEL[id],
  ...rest,
});

/** The container's memory limit killed it (exit 137), or Node ran out of heap. */
function ranOutOfMemory(res: ExecResult): boolean {
  return res.code === 137 || res.log.includes("heap out of memory") || res.log.includes("Reached heap limit");
}

/**
 * The throwaway checkouts of one hand-off run, one per repo, made when a step first needs one and
 * removed when the run ends. A check never runs in the task's own worktree.
 */
class Checkouts {
  private readonly made = new Map<string, Promise<Checkout | undefined>>();
  constructor(
    private readonly ports: HandoffPorts,
    private readonly task: string,
  ) {}

  /** Where a repo's checks run: its copy, or the worktree when majhi cannot make copies. */
  async path(project: string, worktree: string): Promise<string> {
    const { checkout, headCommit } = this.ports;
    if (checkout === undefined || headCommit === undefined) return worktree;
    let made = this.made.get(project);
    if (made === undefined) {
      made = (async () => {
        const commit = await headCommit(this.task, project);
        return commit === undefined ? undefined : checkout(this.task, project, commit, worktree);
      })();
      this.made.set(project, made);
    }
    const copy = await made;
    if (copy === undefined) throw new Error("the task has no commit to check");
    return copy.path;
  }

  async releaseAll(): Promise<void> {
    const copies = await Promise.all([...this.made.values()].map((p) => p.catch(() => undefined)));
    await Promise.all(copies.map((c) => c?.release()));
    this.made.clear();
  }
}

export class HandoffService {
  private readonly slots: Slots;
  private readonly timeouts: Record<HandoffCommandStep, number>;
  private readonly inflight = new Map<string, Promise<HandoffResult>>();
  private readonly running = new Set<string>();
  private readonly waiting = new Set<string>();
  /** Checks someone asked for that have not ended: the card shows them as running at once. */
  private readonly asked = new Set<string>();
  /**
   * Tasks whose check for the current head has no verdict yet: from the moment the task reached
   * review (or a check was asked for) until the verdict is recorded. The owner is not told that
   * such a task is ready: it is still being checked (`gate`).
   */
  private readonly busy = new Set<string>();
  /** The last result for each task, for what the card shows while it has not been judged. */
  private readonly latest = new Map<string, HandoffResult>();
  private readonly background = new Set<Promise<unknown>>();
  /** The step each unfinished check is on, and since when (ms). Read by `activity`. */
  private readonly stage = new Map<string, { step: HandoffStepId; since: number }>();

  constructor(
    private readonly ports: HandoffPorts,
    private readonly repo: HandoffRepo,
    options: HandoffOptions = {},
  ) {
    this.slots = new Slots(options.parallel ?? 2, options.perOrg ?? 1);
    this.timeouts = {
      tests: options.testMs ?? TEST_TIMEOUT_MS,
      build: options.buildMs ?? BUILD_TIMEOUT_MS,
      lint: options.lintMs ?? LINT_TIMEOUT_MS,
      typecheck: options.typecheckMs ?? LINT_TIMEOUT_MS,
      install: options.installMs ?? INSTALL_TIMEOUT_MS,
    };
  }

  private now(): Date {
    return this.ports.now?.() ?? new Date();
  }

  /** Resolves when no check is running or queued. */
  async settled(): Promise<void> {
    while (this.background.size > 0 || this.inflight.size > 0) {
      await Promise.allSettled([...this.background, ...this.inflight.values()]);
    }
  }

  /** The task reached review: check it in the background. A failure here never touches the task. */
  reviewReached(id: string): void {
    this.busy.add(id);
    const work = this.ensure(id, { force: false }).catch(() => undefined);
    this.background.add(work);
    void work.finally(() => {
      this.background.delete(work);
      this.busy.delete(id);
    });
  }

  /**
   * Someone asks for a check now: it runs in the background, the state says when. `only` runs those
   * steps again and keeps the others as they were. `report`: when it ends, the task's lead is told
   * how it went, because an agent asked and is waiting for the answer.
   */
  start(
    id: string,
    force: boolean,
    extra: { only?: readonly HandoffCommandStep[]; report?: boolean } = {},
  ): void {
    if (this.ports.task(id) === undefined) throw new UserError(`There is no task ${id}.`, 404);
    this.asked.add(id);
    this.busy.add(id);
    const work = this.ensure(id, { force, ...(extra.only === undefined ? {} : { only: extra.only }) })
      .then(async (result) => {
        if (extra.report === true) await this.report(id, result, extra.only);
      })
      .catch(() => undefined);
    this.background.add(work);
    void work.finally(() => {
      this.background.delete(work);
      this.asked.delete(id);
      this.busy.delete(id);
    });
  }

  /** An agent's rerun ended: its lead hears the result, green or red, with where the logs are. */
  private async report(
    id: string,
    result: HandoffResult,
    only: readonly HandoffCommandStep[] | undefined,
  ): Promise<void> {
    await this.ports
      .tell(id, rerunNote(result, only), result.failures.length > 0 ? result.failed : undefined)
      .catch(() => undefined);
  }

  /**
   * What the owner's screens may say about a task in review, read without waiting: `running` while
   * the check of its head has no verdict (nothing is "ready" yet), `failed` when the last verdict was
   * red with failures the lead can fix, else undefined (green, no check, or not judged: ready as before).
   * The one gate the decisions, alerts, bell, banner and Home all follow.
   */
  gate(id: string): "running" | "failed" | undefined {
    if (this.busy.has(id)) return "running";
    const last = this.latest.get(id) ?? this.repo.lastResult(id);
    return last !== undefined && last.verdict === "red" && last.failures.length > 0 ? "failed" : undefined;
  }

  /** A task left the board for good: its checks go. */
  forget(id: string): void {
    this.repo.forget(id);
    this.latest.delete(id);
  }

  /**
   * The check of the task's head now: the cheap checks live, the costly part from the cache or run
   * once. Judges the head (history, a note to the lead, the strike count) the first time it is seen.
   * `only` runs those steps again, whatever the cache says, and keeps the others from the last run.
   * A task has one check at a time: a request that cannot share the one that runs waits for it.
   */
  async ensure(
    id: string,
    opts: { force: boolean; only?: readonly HandoffCommandStep[] },
  ): Promise<HandoffResult> {
    const task = this.ports.task(id);
    if (task === undefined) throw new UserError(`There is no task ${id}.`, 404);
    const only =
      opts.only === undefined || opts.only.length === 0 ? undefined : [...new Set(opts.only)].sort();
    for (;;) {
      const head = await this.ports.heads(id);
      const kind = `${opts.force ? "f" : ""}\u0000${only?.join(",") ?? ""}`;
      const key = `${id}\u0000${head}\u0000${kind}`;
      // The same ask for the same head shares one run, and a plain check shares a forced one.
      const joined =
        this.inflight.get(key) ??
        (only === undefined ? this.inflight.get(`${id}\u0000${head}\u0000f\u0000`) : undefined);
      if (joined !== undefined) return joined;
      const live = [...this.inflight].find(([k]) => k.startsWith(`${id}\u0000`));
      if (live !== undefined) {
        await live[1].catch(() => undefined);
        continue;
      }
      const run = this.run(task, head, opts.force, only).finally(() => {
        this.inflight.delete(key);
        this.stage.delete(id);
      });
      this.inflight.set(key, run);
      return run;
    }
  }

  /** The check moved to a step: the rows that show it read it again. */
  private enter(id: string, step: HandoffStepId): void {
    this.stage.set(id, { step, since: this.now().getTime() });
    this.ports.changed(id);
  }

  private async run(
    task: HandoffTask,
    head: string,
    force: boolean,
    only: readonly HandoffCommandStep[] | undefined,
  ): Promise<HandoffResult> {
    const started = this.now().getTime();
    this.stage.set(task.id, { step: "ready", since: started });
    const ready = await this.ports.ready(task.id);
    if (!ready.ok && ready.empty === true) return this.runEmpty(task, head, started);
    const readyStep: HandoffStep = ready.ok
      ? step("ready", { status: "pass", detail: ready.evidence })
      : step("ready", {
          status: "fail",
          detail: ready.why,
          ...(ready.owner === true ? { owner: true as const } : {}),
        });

    let deep: { steps: HandoffStep[]; review: HandoffReview; ms: number; cached: boolean };
    const prior = this.repo.deep(task.id, head);
    let kept = force || only !== undefined ? undefined : prior;
    const environment = this.ports.environment?.() ?? "";
    // A failure that majhi's update or a changed runner may have fixed, or that is hours old, runs again.
    const previous = kept;
    const retried = previous !== undefined && this.worthRetrying(previous, environment);
    if (retried) kept = undefined;
    const attempts = retried && previous !== undefined ? previous.attempts + 1 : (prior?.attempts ?? 1);
    if (!ready.ok && kept === undefined) {
      const skip = (id: HandoffStepId): HandoffStep =>
        step(id, { status: "skipped", detail: "not run until the first problem is fixed" });
      deep = {
        steps: [skip("tests"), skip("build"), skip("lint"), skip("acceptance")],
        review: { by: "skipped", why: "the first checks did not pass", notes: [], tokens: 0 },
        ms: 0,
        cached: false,
      };
    } else {
      if (kept !== undefined) {
        deep = { steps: kept.steps, review: kept.review, ms: kept.ms, cached: true };
      } else {
        this.waiting.add(task.id);
        this.stage.set(task.id, { step: "ready", since: this.now().getTime() });
        this.ports.changed(task.id);
        try {
          const costly = await this.slots.run(task.org, () => {
            this.waiting.delete(task.id);
            this.running.add(task.id);
            this.enter(task.id, "lint");
            return this.deepCheck(task, force, newRunId(this.now().getTime()), only, prior);
          });
          deep = { ...costly, cached: false };
          // A step majhi could not run is not cached: the next look tries again.
          if (!costly.steps.some((s) => s.owner === true)) {
            this.repo.putDeep({
              task: task.id,
              head,
              at: this.now().toISOString(),
              ms: costly.ms,
              steps: costly.steps,
              review: costly.review,
              env: environment,
              attempts,
            });
          }
        } finally {
          this.waiting.delete(task.id);
          this.running.delete(task.id);
        }
      }
    }

    const steps = [readyStep, ...deep.steps];
    const failures: string[] = [];
    const held: string[] = [];
    for (const s of steps) {
      if (s.status !== "fail" && s.status !== "timeout" && s.status !== "flaky") continue;
      const line = s.output === undefined || s.output === "" ? s.detail : `${s.detail}\n${s.output}`;
      (s.owner === true ? held : failures).push(line);
    }
    const bad = steps.find(
      (s) => s.owner !== true && (s.status === "fail" || s.status === "timeout" || s.status === "flaky"),
    );
    const failed: HandoffFailed | undefined =
      bad === undefined
        ? undefined
        : {
            step: bad.id,
            label: bad.label,
            status: bad.status,
            code: bad.code ?? null,
            ms: bad.ms ?? 0,
            ...(bad.log === undefined ? {} : { log: bad.log }),
          };
    const result: HandoffResult = {
      task: task.id,
      head,
      at: this.now().toISOString(),
      verdict: failures.length === 0 && held.length === 0 ? "green" : "red",
      steps,
      review: deep.review,
      failures,
      ...(failed === undefined ? {} : { failed }),
      held,
      ms: this.now().getTime() - started,
      cached: deep.cached,
      summary: handoffSummary(steps, deep.review),
    };
    this.latest.set(task.id, result);
    // The verdict is in: the judgment below may put a line on the card, which must read as judged.
    this.busy.delete(task.id);
    await this.judge(task, result, force || retried || only !== undefined);
    this.ports.changed(task.id);
    return result;
  }

  /** A task that changed no code (a report-only task): green, with no tests or build to run and nothing to ship. */
  private async runEmpty(task: HandoffTask, head: string, started: number): Promise<HandoffResult> {
    const steps = [step("ready", { status: "none", detail: "No code changes" })];
    const review: HandoffReview = {
      by: "skipped",
      why: "there is no change to review",
      notes: [],
      tokens: 0,
    };
    const result: HandoffResult = {
      task: task.id,
      head,
      at: this.now().toISOString(),
      verdict: "green",
      steps,
      review,
      failures: [],
      held: [],
      ms: this.now().getTime() - started,
      cached: false,
      summary: handoffSummary(steps, review),
    };
    this.latest.set(task.id, result);
    this.busy.delete(task.id);
    await this.judge(task, result, false);
    this.ports.changed(task.id);
    return result;
  }

  /**
   * A kept failure is tried again when what it ran in changed (majhi's commit or the runner image; a
   * failure kept before this was recorded counts as changed) or it is old, at most `MAX_ATTEMPTS`
   * times for one head. A step majhi could not run, or a pass, is never retried here.
   */
  private worthRetrying(kept: DeepRow, environment: string): boolean {
    const failed = kept.steps.some(
      (s) => s.status === "fail" || s.status === "timeout" || s.status === "flaky",
    );
    if (!failed || kept.attempts >= MAX_ATTEMPTS) return false;
    const changed = environment !== "" && kept.env !== environment;
    const old = this.now().getTime() - new Date(kept.at).getTime() >= RETRY_AFTER_MS;
    return changed || old;
  }

  // -------------------------------------------------------------------------
  // The costly part

  /**
   * The costly part. `only` runs just those steps and takes the rest from `prior`, the last run of
   * this head, when there is one: a step that was skipped because another failed runs once that
   * one passes.
   */
  private async deepCheck(
    task: HandoffTask,
    force: boolean,
    runId: string,
    only: readonly HandoffCommandStep[] | undefined,
    prior: DeepRow | undefined,
  ): Promise<{ steps: HandoffStep[]; review: HandoffReview; ms: number }> {
    const started = this.now().getTime();
    const before = (id: HandoffStepId) => prior?.steps.find((s) => s.id === id);
    const redo = (id: HandoffCommandStep) => only === undefined || prior === undefined || only.includes(id);
    const stop = (s: HandoffStep | undefined) => s?.status === "fail" || s?.status === "timeout";
    const work = new Checkouts(this.ports, task.id);
    try {
      return await this.deepSteps(task, force, runId, only, prior, started, { before, redo, stop, work });
    } finally {
      await work.releaseAll();
    }
  }

  private async deepSteps(
    task: HandoffTask,
    force: boolean,
    runId: string,
    only: readonly HandoffCommandStep[] | undefined,
    prior: DeepRow | undefined,
    started: number,
    h: {
      before: (id: HandoffStepId) => HandoffStep | undefined;
      redo: (id: HandoffCommandStep) => boolean;
      stop: (s: HandoffStep | undefined) => boolean;
      work: Checkouts;
    },
  ): Promise<{ steps: HandoffStep[]; review: HandoffReview; ms: number }> {
    const { before, redo, stop, work } = h;
    const asked = only?.includes("install") === true;
    let install: HandoffStep | undefined = before("install");
    if (redo("install")) {
      this.enter(task.id, "install");
      install = await this.command(task, "install", runId, work, asked);
    }
    const notInstalled = stop(install);
    const skipped = (id: HandoffCommandStep): HandoffStep =>
      step(id, { status: "skipped", detail: "not run: the install failed" });

    this.enter(task.id, "lint");
    const reuse = (id: HandoffCommandStep) => (redo(id) ? undefined : before(id));
    const lint = notInstalled
      ? skipped("lint")
      : (reuse("lint") ?? (await this.command(task, "lint", runId, work)));
    this.enter(task.id, "typecheck");
    const typecheck = notInstalled
      ? skipped("typecheck")
      : (reuse("typecheck") ?? (await this.command(task, "typecheck", runId, work)));
    this.enter(task.id, "build");
    const build = notInstalled
      ? skipped("build")
      : (reuse("build") ?? (await this.command(task, "build", runId, work)));
    // A build that does not build makes the tests say nothing, unless they were asked for by name.
    const testsBefore = before("tests");
    const asksTests = only?.includes("tests") === true;
    const keepTests = !asksTests && !redo("tests") && !(testsBefore?.status === "skipped" && !stop(build));
    const tests = notInstalled
      ? skipped("tests")
      : keepTests && testsBefore !== undefined
        ? testsBefore
        : stop(build) && !asksTests
          ? step("tests", { status: "skipped", detail: "not run: the build failed" })
          : await (async () => {
              this.enter(task.id, "tests");
              return this.command(task, "tests", runId, work);
            })();
    const diff = await this.ports.diff(task.id).catch(() => undefined);
    const hasTests = (
      await Promise.all(
        task.repos.map(async (r) => (await this.ports.commands(r.project)).test !== undefined),
      )
    ).some(Boolean);
    const lines = diff === undefined ? [] : acceptanceLines(task.brief);
    const items = diff === undefined ? [] : matchAcceptance(lines, diff);
    const unmatched = items.filter((i) => !i.ok);
    const acceptance =
      items.length === 0
        ? step("acceptance", { status: "none", detail: "the brief has no checklist or done-when lines" })
        : step("acceptance", {
            status: unmatched.length === 0 ? "pass" : "note",
            detail:
              unmatched.length === 0
                ? `${items.length} of ${items.length} lines matched`
                : `${unmatched.length} of ${items.length} lines with no evidence`,
            items,
          });
    const failed = [install, lint, typecheck, build, tests].some(
      (s) => s?.status === "fail" || s?.status === "timeout" || s?.status === "flaky",
    );
    // A step rerun alone does not spend on the model again: a review that was read stays.
    const kept =
      only !== undefined && prior !== undefined && prior.review.by !== "skipped" ? prior.review : undefined;
    const review =
      diff === undefined
        ? ({ by: "skipped", why: "the diff could not be read", notes: [], tokens: 0 } satisfies HandoffReview)
        : failed
          ? ({
              by: "skipped",
              why: "the tests, build or lint did not pass",
              notes: [],
              tokens: 0,
            } satisfies HandoffReview)
          : (kept ??
            (await (async () => {
              this.enter(task.id, "review");
              return this.review(task, diff, hasTests, force && only === undefined);
            })()));
    const reviewStep = step("review", {
      status: review.by === "skipped" ? "skipped" : review.notes.length > 0 ? "note" : "pass",
      detail:
        review.by === "skipped"
          ? (review.why ?? "not run")
          : review.notes.length === 0
            ? "no notes"
            : `${review.notes.length} ${review.notes.length === 1 ? "note" : "notes"}`,
    });
    return {
      // Install shows only when it ran or failed: a project with its packages in place has no install step.
      steps: [
        ...(install === undefined || install.status === "none" ? [] : [install]),
        tests,
        build,
        lint,
        ...(typecheck.status === "none" ? [] : [typecheck]),
        acceptance,
        reviewStep,
      ],
      review,
      ms: this.now().getTime() - started,
    };
  }

  /** What one step's timeout is: the project's own minutes for tests and build, then settings, then the default. */
  private async timeoutOf(
    project: string,
    kind: HandoffCommandStep,
  ): Promise<{ ms: number; caps: HandoffLimits | undefined }> {
    const caps = await this.ports.limits?.(project);
    const own = kind === "tests" || kind === "build" ? caps?.minutes : undefined;
    const minutes = own ?? caps?.stepMinutes?.[kind];
    return { ms: minutes === undefined ? this.timeouts[kind] : minutes * MINUTE, caps };
  }

  /** The whole output of the step, saved as a file the viewer opens. A log that could not be saved leaves the step without one. */
  private async withLog(
    task: HandoffTask,
    runId: string,
    kind: HandoffCommandStep,
    log: StepLog,
    result: HandoffStep,
  ): Promise<HandoffStep> {
    const saved = this.ports.saveLog;
    if (saved === undefined) return result;
    try {
      const { text, log: facts } = log.finish(logPath(runId, kind));
      await saved(task.id, runId, kind, text);
      return { ...result, log: facts };
    } catch {
      return result;
    }
  }

  /** The check of one kind for one repo: the project's own setting, else its CI, else its card. */
  private async specOf(
    task: HandoffTask,
    r: { project: string; worktree?: string | undefined },
    kind: HandoffCommandStep,
  ): Promise<CheckSpec | undefined> {
    if (this.ports.checkSpec !== undefined && r.worktree !== undefined) {
      return this.ports.checkSpec(task.id, r.project, kind, r.worktree);
    }
    const key = kind === "tests" ? "test" : kind;
    const command = (await this.ports.commands(r.project))[key];
    return command === undefined || command.trim() === ""
      ? undefined
      : { command, env: {}, from: "from the project card" };
  }

  /**
   * One kind of command over the task's repos. Each runs in a throwaway checkout of the task's head, in
   * the environment of the CI job it was read from, and only in a form that does not write. Tests that
   * fail run once more: pass on retry is flaky. A failure the base commit has too is "existing", not the
   * task's. `install` runs only in a repo whose packages are missing, unless `always`.
   */
  private async command(
    task: HandoffTask,
    kind: HandoffCommandStep,
    runId: string,
    work: Checkouts,
    always = false,
  ): Promise<HandoffStep> {
    // The services a job starts for a check are removed however the step ends.
    const stops: (() => Promise<void>)[] = [];
    try {
      return await this.commandSteps(task, kind, runId, work, always, stops);
    } finally {
      await Promise.all(stops.map((stop) => stop().catch(() => undefined)));
    }
  }

  private async commandSteps(
    task: HandoffTask,
    kind: HandoffCommandStep,
    runId: string,
    work: Checkouts,
    always: boolean,
    stops: (() => Promise<void>)[],
  ): Promise<HandoffStep> {
    interface Run {
      project: string;
      worktree: string;
      cwd: string;
      workdir: string | undefined;
      command: string;
      env: Record<string, string>;
      ran: HandoffRan;
      minutes: number | undefined;
      services: CiService[];
    }
    const runs: Run[] = [];
    const skipped: string[] = [];
    for (const r of task.repos) {
      if (r.worktree === undefined) continue;
      const spec = await this.specOf(task, r, kind);
      if (spec === undefined || spec.command.trim() === "") continue;
      let where: string;
      try {
        where = await work.path(r.project, r.worktree);
      } catch (err) {
        return step(kind, {
          status: "fail",
          detail: `majhi could not make a copy of ${r.project} to check: ${errorMessage(err)}`,
          owner: true,
        });
      }
      if (kind === "install" && !always && (await this.ports.needsInstall?.(where)) !== true) continue;
      let line = spec.command;
      if (usesBase(line)) {
        const base = await this.ports.mergeBase?.(task.id, r.project).catch(() => undefined);
        const filled = substituteBase(line, base);
        if ("error" in filled) {
          return step(kind, {
            status: "fail",
            detail: `${spec.command} could not run in ${r.project}: ${filled.error}`,
            owner: true,
          });
        }
        line = filled.command;
      }
      const cwd = spec.workdir === undefined ? where : join(where, spec.workdir);
      const ports = this.ports;
      const safe =
        kind === "install"
          ? ({ ok: true, command: line, notes: [] } as const)
          : await safeLine(line, (name) => ports.script?.(cwd, name) ?? Promise.resolve(undefined));
      if (!safe.ok) {
        skipped.push(`${spec.command} in ${r.project} was not run: ${safe.why}`);
        continue;
      }
      runs.push({
        project: r.project,
        worktree: r.worktree,
        cwd,
        workdir: spec.workdir,
        command: safe.command,
        env: spec.env,
        minutes: spec.minutes,
        services: kind === "install" ? [] : (spec.services ?? []),
        ran: {
          project: r.project,
          command: safe.command,
          from: spec.from,
          env: spec.env,
          ...(spec.workdir === undefined ? {} : { workdir: spec.workdir }),
          notes: [...safe.notes],
        },
      });
    }
    if (runs.length === 0) {
      return step(kind, {
        status: skipped.length > 0 ? "skipped" : "none",
        detail:
          skipped.length > 0
            ? skipped.join("; ")
            : kind === "tests"
              ? "the project card has no test command, so nothing was tested"
              : kind === "install"
                ? "the packages are in place"
                : `the project card has no ${kind === "typecheck" ? "type check" : kind} command`,
      });
    }
    const ran = runs.map((r) => r.ran);
    const finish = (rest: Omit<HandoffStep, "id" | "label" | "ran">): HandoffStep =>
      step(kind, { ...rest, ran });
    const many = task.repos.length > 1;
    const log = new StepLog();
    let total = 0;
    let counted = 0;
    let countedAny = false;
    const header = (r: { project: string; command: string }, res: ExecResult, note = "") =>
      `==> ${r.command} in ${r.project}${note}: ${res.timedOut ? "stopped, it did not finish" : `exit ${res.code ?? "none"}`} after ${handoffSeconds(res.ms)}`;
    for (const r of runs) {
      const where = many ? ` in ${r.project}` : "";
      const { ms: ownMs, caps } = await this.timeoutOf(r.project, kind);
      const ownSet = caps?.minutes !== undefined && (kind === "tests" || kind === "build");
      const timeoutMs =
        !ownSet && caps?.stepMinutes?.[kind] === undefined && r.minutes !== undefined
          ? Math.max(ownMs, r.minutes * MINUTE)
          : ownMs;
      const more =
        kind === "lint"
          ? ""
          : `. To allow more, set containers.handoff_step_minutes.${kind} or containers.handoff_minutes.${r.project} (now ${Math.round(timeoutMs / MINUTE)}) or containers.handoff_cpus${caps === undefined ? "" : ` (now ${caps.cpus})`}`;
      const limits = caps === undefined ? undefined : { cpus: caps.cpus, memory: caps.memory };
      const wantsMb = impliedMemoryMb(r.env);
      // Without a limit the owner set, a check gets at least what its CI's environment implies.
      if (
        limits !== undefined &&
        caps?.memorySet !== true &&
        wantsMb !== undefined &&
        wantsMb > memoryMb(limits.memory)
      ) {
        const ceiling = memoryMb(caps?.memoryCeiling ?? limits.memory);
        limits.memory = `${Math.floor(Math.min(Math.ceil(wantsMb / 1024) * 1024, Math.max(ceiling, memoryMb(limits.memory))) / 1024)}g`;
      }
      if (limits !== undefined && wantsMb !== undefined && wantsMb > memoryMb(limits.memory)) {
        r.ran.notes.push(
          `the CI gives Node a ${sizeWords(`${Math.round(wantsMb / 1024)}g`)} heap and headroom, and the limit here is ${sizeWords(limits.memory)}`,
        );
      }
      if (r.services.length > 0) {
        const started = await startServices(
          (command, ms) => this.ports.exec(task.id, r.cwd, command, ms, limits),
          r.services,
        );
        if (!started.ok) {
          return finish({ status: "fail", detail: started.why, ms: total, owner: true });
        }
        stops.push(started.stop);
        r.ran.notes.push(...started.notes);
      }
      const run = () => this.ports.exec(task.id, r.cwd, r.command, timeoutMs, limits, r.env);
      let res = await run();
      total += res.ms;
      if (res.error !== undefined) {
        return finish({
          status: "fail",
          detail: `${r.command} could not run${where}: ${res.error}`,
          ms: total,
          owner: true,
        });
      }
      if (res.timedOut) {
        const tail = outputTail(res.output);
        log.add(header(r, res), res.log, tail);
        return this.withLog(
          task,
          runId,
          kind,
          log,
          finish({
            status: "timeout",
            detail: `\`${r.command}\` did not finish in ${handoffSeconds(timeoutMs)}${where}, so it was stopped${more}`,
            ms: total,
            output: tail,
            code: null,
          }),
        );
      }
      if (res.code !== 0) {
        const first = res;
        if (kind === "tests") {
          log.add(header(r, first, " (first run)"), first.log, outputTail(first.output));
          res = await run();
          total += res.ms;
          if (res.error === undefined && !res.timedOut && res.code === 0) {
            log.add(header(r, res, " (retry)"), res.log);
            return this.withLog(
              task,
              runId,
              kind,
              log,
              finish({
                status: "flaky",
                detail: `\`${r.command}\` failed, then passed on a retry${where}: flaky, so not green`,
                ms: total,
                output: outputTail(first.output),
                code: first.code,
              }),
            );
          }
        }
        const tail = outputTail(res.output);
        log.add(header(r, res, kind === "tests" ? " (retry)" : ""), res.log, tail);
        if (!res.timedOut && ranOutOfMemory(res) && limits !== undefined) {
          return this.withLog(
            task,
            runId,
            kind,
            log,
            finish({
              status: "fail",
              detail: `Ran out of memory at ${sizeWords(limits.memory)}${where}: raise it in this project's Check before ship`,
              ms: total,
              output: tail,
              code: res.code,
              memory: { limit: limits.memory },
              owner: true,
            }),
          );
        }
        const existing =
          kind === "install" || res.timedOut
            ? undefined
            : await this.againstBase(task, kind, r, res, timeoutMs, limits, r.worktree);
        if (existing !== undefined && existing.fresh.length === 0) {
          return this.withLog(
            task,
            runId,
            kind,
            log,
            finish({
              status: "existing",
              detail: `\`${r.command}\` fails${where}, and it already failed on ${existing.base} before this task: not blocking`,
              ms: total,
              output: tail,
              code: res.code,
              existing: {
                base: existing.base,
                problems: existing.problems,
                ...(existing.finding === undefined ? {} : { finding: existing.finding }),
              },
            }),
          );
        }
        const fresh =
          existing === undefined || existing.fresh.length === 0
            ? ""
            : `, ${existing.fresh.length} new on this task`;
        return this.withLog(
          task,
          runId,
          kind,
          log,
          finish({
            status: res.timedOut ? "timeout" : "fail",
            detail: res.timedOut
              ? `\`${r.command}\` did not finish in ${handoffSeconds(timeoutMs)} on its retry${where}${more}`
              : `\`${r.command}\` failed${where} (exit ${res.code ?? "none"}, ${handoffSeconds(res.ms)}${kind === "tests" ? ", also on a retry" : ""}${fresh})`,
            ms: total,
            output: tail,
            code: res.code,
          }),
        );
      }
      log.add(header(r, res), res.log);
      const n = passedCount(res.output);
      if (n !== undefined) {
        counted += n;
        countedAny = true;
      }
    }
    return this.withLog(
      task,
      runId,
      kind,
      log,
      finish({
        status: "pass",
        detail: kind === "tests" && countedAny ? `${counted} passed` : "ok",
        ms: total,
        code: 0,
      }),
    );
  }

  /**
   * The same check on the commit the task branched from, once for each base and check (kept by base,
   * command and environment), compared with what failed here. Undefined when the base cannot be run, so
   * the failure counts as the task's.
   */
  private async againstBase(
    task: HandoffTask,
    kind: HandoffCommandStep,
    r: {
      project: string;
      workdir: string | undefined;
      command: string;
      env: Record<string, string>;
    },
    head: ExecResult,
    timeoutMs: number,
    limits: ExecLimits | undefined,
    installedFrom: string,
  ): Promise<{ base: string; fresh: string[]; problems: string[]; finding?: number } | undefined> {
    const ports = this.ports;
    if (ports.checkout === undefined || ports.mergeBase === undefined) return undefined;
    const commit = await ports.mergeBase(task.id, r.project).catch(() => undefined);
    if (commit === undefined) return undefined;
    const problemKind: ProblemKind = kind === "tests" ? "test" : kind === "install" ? "build" : kind;
    // The head's installed packages are right for the base only while the task left what is installed alone.
    const ownInstall =
      (await ports.dependenciesChanged?.(task.id, r.project, commit).catch(() => false)) === true;
    const key = createHash("sha1")
      .update(
        JSON.stringify([r.project, commit, kind, r.command, r.env, r.workdir ?? "", ownInstall ? "own" : ""]),
      )
      .digest("hex");
    let base = await ports.baseRuns?.get(key).catch(() => undefined);
    if (base === undefined) {
      let copy: Checkout | undefined;
      try {
        copy = await ports.checkout(task.id, r.project, commit, ownInstall ? undefined : installedFrom);
        if (ownInstall) {
          const install = await this.specOf(task, { project: r.project, worktree: installedFrom }, "install");
          // No way to install for the base: the comparison would be off, so the failure is not called existing.
          if (install === undefined || install.command.trim() === "") return undefined;
          const done = await ports.exec(
            task.id,
            copy.path,
            install.command,
            this.timeouts.install,
            limits,
            install.env,
          );
          if (done.error !== undefined || done.timedOut || done.code !== 0) return undefined;
        }
        const where = r.workdir === undefined ? copy.path : join(copy.path, r.workdir);
        const res = await ports.exec(task.id, where, r.command, timeoutMs, limits, r.env);
        // A base that could not be run says nothing about the task.
        if (res.error !== undefined || res.timedOut) return undefined;
        base = {
          passed: res.code === 0,
          ...(res.code === 0 ? {} : { problems: problemsOf(problemKind, res.log) }),
        };
        await ports.baseRuns?.put(key, base).catch(() => undefined);
      } catch {
        return undefined;
      } finally {
        await copy?.release();
      }
    }
    const cmp = compareFailures(problemKind, head.log, {
      passed: base.passed,
      problems: base.problems,
    });
    const short = commit.slice(0, 8);
    if (cmp.fresh.length > 0 || base.passed)
      return { base: short, fresh: cmp.fresh.length > 0 ? cmp.fresh : ["failed"], problems: [] };
    const finding = await ports
      .reportExisting?.({
        task: task.id,
        project: r.project,
        kind,
        command: r.command,
        base: short,
        problems: cmp.existing,
        tail: outputTail(head.output),
      })
      .catch(() => undefined);
    return { base: short, fresh: [], problems: cmp.existing, ...(finding === undefined ? {} : { finding }) };
  }

  private async review(
    task: HandoffTask,
    diff: DiffFacts,
    hasTests: boolean,
    force: boolean,
  ): Promise<HandoffReview> {
    if (isDocsOnly(diff)) return { by: "skipped", why: "a docs-only change", notes: [], tokens: 0 };
    const notes = freeReview(diff, { brief: task.brief, hasTests });
    const lines = changedLines(diff);
    if (lines < TRIVIAL_LINES) return { by: "code", why: "a small change", notes, tokens: 0 };
    const quiet = !this.ports.autonomous() && !force;
    if (quiet) {
      return {
        by: "code",
        why: "the model reads it when Auto-pilot is on or you press Check again",
        notes,
        tokens: 0,
      };
    }
    const blocked = this.ports.modelBlocked(task.org);
    if (blocked !== undefined) return { by: "code", why: blocked, notes, tokens: 0 };
    try {
      const prompt = reviewPrompt(task.brief, diff, patchBudget(lines));
      const { gaps, tokens } = await this.ports.review({ id: task.id, org: task.org }, prompt);
      const merged = [...notes];
      for (const g of gaps) if (!merged.includes(g)) merged.push(g);
      return { by: "model", notes: merged.slice(0, 8), tokens };
    } catch (err) {
      return {
        by: "code",
        why: `the model pass did not run: ${errorMessage(err)}`.slice(0, 200),
        notes,
        tokens: 0,
      };
    }
  }

  // -------------------------------------------------------------------------
  // What happens to a verdict

  /**
   * Judges a head the first time it is checked: green clears the strikes; red the lead can fix is
   * told once, and the third in a row goes to the owner with the history. A head already judged is
   * not judged again, so a re-check or a second reader costs no new strike and no second note.
   */
  private async judge(task: HandoffTask, result: HandoffResult, force: boolean): Promise<void> {
    const { head } = result;
    const item = (action: HandoffHistoryItem["action"]): HandoffHistoryItem => ({
      head,
      at: result.at,
      verdict: result.verdict,
      failures: result.failures,
      action,
    });
    if (result.verdict === "green") {
      const existing = this.repo.historyOf(task.id, head);
      if (existing === undefined) this.repo.addHistory(task.id, item("none"), result);
      else if (force) this.repo.replaceHistory(task.id, item(existing.action), result);
      this.repo.setState(task.id, 0, false);
      this.ports.hold(task.id, undefined);
      return;
    }
    // Only the owner can clear it (a card waits): not a judgment of the work.
    if (result.failures.length === 0) return;

    const existing = this.repo.historyOf(task.id, head);
    const state = this.repo.state(task.id);
    // The lead is told of a failure whether or not Autonomous is on. Only the owner's switch for
    // "Checks fail: send the failures to the lead" stops it: then the card says why.
    const tells = this.ports.ruleOff?.(task.org, "ship-checks") !== true;
    if (existing !== undefined) {
      if (force) this.repo.replaceHistory(task.id, item(existing.action), result);
      // Failed while the switch was off and it is on now: the lead is told, once, with no new strike.
      if (existing.action === "none" && !state.escalated && tells) {
        await this.tellLead(task, result, Math.max(1, state.strikes));
        return;
      }
      // The same head again: the card says why it is still not ready, and nobody is told twice.
      this.ports.hold(
        task.id,
        existing.action === "told"
          ? `${what(result)} failed. The lead was told and has not committed a fix since.`
          : `${what(result)} failed${state.escalated ? ` ${state.strikes} times in a row` : ""}.`,
      );
      return;
    }
    const strikes = state.strikes + 1;
    this.repo.addHistory(task.id, item("none"), result);
    if (!tells) {
      this.ports.hold(task.id, `${what(result)} failed.`);
      return;
    }
    if (strikes >= HANDOFF_STRIKES || state.escalated) {
      this.repo.setState(task.id, strikes, true);
      this.repo.setAction(task.id, head, "escalated");
      this.ports.hold(
        task.id,
        `${what(result)} failed ${strikes} times in a row, so the lead is not told again.`,
      );
      return;
    }
    this.repo.setState(task.id, strikes, false);
    await this.tellLead(task, result, strikes);
  }

  private async tellLead(task: HandoffTask, result: HandoffResult, attempt: number): Promise<void> {
    try {
      await this.ports.tell(task.id, failureNote(result, attempt, HANDOFF_STRIKES), result.failed);
      this.repo.setAction(task.id, result.head, "told");
    } catch (err) {
      // No lead to tell (paused, done, no agent): the owner sees the failure on the card.
      this.ports.hold(
        task.id,
        `${what(result)} failed and the lead could not be told (${errorMessage(err)}).`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reads

  async state(id: string): Promise<HandoffState> {
    if (this.ports.task(id) === undefined) throw new UserError(`There is no task ${id}.`, 404);
    const head = await this.ports.heads(id).catch(() => "");
    const kept = this.latest.get(id);
    const current = kept?.head === head ? kept : this.repo.resultOf(id, head);
    const last = kept ?? undefined;
    const { strikes, escalated } = this.repo.state(id);
    return {
      task: id,
      ...(current === undefined ? (last === undefined ? {} : { current: last }) : { current }),
      stale: current === undefined && last !== undefined,
      history: this.repo.history(id),
      strikes,
      escalated,
      running: this.running.has(id) || this.asked.has(id),
      queued: this.waiting.has(id),
      ...this.activityOf(id),
    };
  }

  /** What an unfinished check is doing: its place in the queue, or the step it is on. */
  private activityOf(id: string): { activity?: HandoffActivity } {
    const at = this.stage.get(id);
    const since = new Date(at?.since ?? this.now().getTime()).toISOString();
    if (this.waiting.has(id)) {
      return { activity: { phase: "queued", since, position: [...this.waiting].indexOf(id) + 1 } };
    }
    if (this.running.has(id) || this.asked.has(id)) {
      return { activity: { phase: "running", since, ...(at === undefined ? {} : { step: at.step }) } };
    }
    return {};
  }
}

/** The first line of the first failure: what the card says, short. */
/** The step that failed, by its name on the card ("Tests", "Lint"), for the line the card shows. The card has its log. */
function what(result: HandoffResult): string {
  return result.failed?.label ?? "The checks";
}
