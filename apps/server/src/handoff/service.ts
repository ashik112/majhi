import {
  HANDOFF_STRIKES,
  type HandoffActivity,
  type HandoffHistoryItem,
  type HandoffResult,
  type HandoffReview,
  type HandoffState,
  type HandoffStep,
  type HandoffStepId,
  handoffSeconds,
  handoffSummary,
} from "@majhi/shared";
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
  reviewPrompt,
  TRIVIAL_LINES,
} from "./analysis.ts";
import { substituteBase, usesBase } from "./commands.ts";
import type { DeepRow, HandoffRepo } from "./repo.ts";

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
  minutes: number | undefined;
}

export interface CardCommands {
  test?: string | undefined;
  build?: string | undefined;
  lint?: string | undefined;
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
  /** Runs one shell line in a task's worktree, in its runner, with a timeout. */
  exec(
    task: string,
    cwd: string,
    command: string,
    timeoutMs: number,
    limits?: ExecLimits,
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
  tell(id: string, text: string): Promise<void>;
  /** Puts a line on the task's review card for the owner, or clears the check's line. */
  hold(id: string, line: string | undefined): void;
  changed(id: string): void;
  now?: () => Date;
}

export interface HandoffOptions {
  testMs?: number;
  buildMs?: number;
  lintMs?: number;
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
  tests: "Tests",
  build: "Build",
  lint: "Lint",
  acceptance: "Brief",
  review: "Review",
};

const step = (id: HandoffStepId, rest: Omit<HandoffStep, "id" | "label">): HandoffStep => ({
  id,
  label: LABEL[id],
  ...rest,
});

export class HandoffService {
  private readonly slots: Slots;
  private readonly timeouts: Record<"tests" | "build" | "lint", number>;
  private readonly inflight = new Map<string, Promise<HandoffResult>>();
  private readonly running = new Set<string>();
  private readonly waiting = new Set<string>();
  /** Checks someone asked for that have not ended: the card shows them as running at once. */
  private readonly asked = new Set<string>();
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
    const work = this.ensure(id, { force: false }).catch(() => undefined);
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  /** The owner or the captain asks for a check now: it runs in the background, the state says when. */
  start(id: string, force: boolean): void {
    if (this.ports.task(id) === undefined) throw new UserError(`There is no task ${id}.`, 404);
    this.asked.add(id);
    const work = this.ensure(id, { force }).catch(() => undefined);
    this.background.add(work);
    void work.finally(() => {
      this.background.delete(work);
      this.asked.delete(id);
    });
  }

  /** A task left the board for good: its checks go. */
  forget(id: string): void {
    this.repo.forget(id);
    this.latest.delete(id);
  }

  /**
   * The check of the task's head now: the cheap checks live, the costly part from the cache or run
   * once. Judges the head (history, a note to the lead, the strike count) the first time it is seen.
   */
  async ensure(id: string, opts: { force: boolean }): Promise<HandoffResult> {
    const task = this.ports.task(id);
    if (task === undefined) throw new UserError(`There is no task ${id}.`, 404);
    const head = await this.ports.heads(id);
    // One run per task and head at a time: a second caller waits for the first and gets its result.
    const key = `${id}\u0000${head}\u0000${opts.force ? "f" : ""}`;
    const joined = this.inflight.get(key) ?? this.inflight.get(`${id}\u0000${head}\u0000f`);
    if (joined !== undefined) return joined;
    const run = this.run(task, head, opts.force).finally(() => {
      this.inflight.delete(key);
      this.stage.delete(id);
    });
    this.inflight.set(key, run);
    return run;
  }

  /** The check moved to a step: the rows that show it read it again. */
  private enter(id: string, step: HandoffStepId): void {
    this.stage.set(id, { step, since: this.now().getTime() });
    this.ports.changed(id);
  }

  private async run(task: HandoffTask, head: string, force: boolean): Promise<HandoffResult> {
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
    let kept = force ? undefined : this.repo.deep(task.id, head);
    const environment = this.ports.environment?.() ?? "";
    // A failure that majhi's update or a changed runner may have fixed, or that is hours old, runs again.
    const previous = kept;
    const retried = previous !== undefined && this.worthRetrying(previous, environment);
    if (retried) kept = undefined;
    const attempts = retried && previous !== undefined ? previous.attempts + 1 : 1;
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
            return this.deepCheck(task, force);
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
    const result: HandoffResult = {
      task: task.id,
      head,
      at: this.now().toISOString(),
      verdict: failures.length === 0 && held.length === 0 ? "green" : "red",
      steps,
      review: deep.review,
      failures,
      held,
      ms: this.now().getTime() - started,
      cached: deep.cached,
      summary: handoffSummary(steps, deep.review),
    };
    this.latest.set(task.id, result);
    await this.judge(task, result, force || retried);
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

  private async deepCheck(
    task: HandoffTask,
    force: boolean,
  ): Promise<{ steps: HandoffStep[]; review: HandoffReview; ms: number }> {
    const started = this.now().getTime();
    const lint = await this.command(task, "lint");
    this.enter(task.id, "build");
    const build = await this.command(task, "build");
    // A build that does not build makes the tests say nothing.
    const tests =
      build.status === "fail" || build.status === "timeout"
        ? step("tests", { status: "skipped", detail: "not run: the build failed" })
        : await (async () => {
            this.enter(task.id, "tests");
            return this.command(task, "tests");
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
    const failed = [lint, build, tests].some(
      (s) => s.status === "fail" || s.status === "timeout" || s.status === "flaky",
    );
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
          : await (async () => {
              this.enter(task.id, "review");
              return this.review(task, diff, hasTests, force);
            })();
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
      steps: [tests, build, lint, acceptance, reviewStep],
      review,
      ms: this.now().getTime() - started,
    };
  }

  /** One kind of command over the task's repos. Tests that fail run once more: pass on retry is flaky. */
  private async command(task: HandoffTask, kind: "tests" | "build" | "lint"): Promise<HandoffStep> {
    const key = kind === "tests" ? "test" : kind;
    const runs: { project: string; cwd: string; command: string }[] = [];
    for (const r of task.repos) {
      const command = (await this.ports.commands(r.project))[key];
      if (command === undefined || command.trim() === "" || r.worktree === undefined) continue;
      let line = command;
      if (usesBase(command)) {
        const base = await this.ports.mergeBase?.(task.id, r.project).catch(() => undefined);
        const filled = substituteBase(command, base);
        if ("error" in filled) {
          return step(kind, {
            status: "fail",
            detail: `${command} could not run in ${r.project}: ${filled.error}`,
            owner: true,
          });
        }
        line = filled.command;
      }
      runs.push({ project: r.project, cwd: r.worktree, command: line });
    }
    if (runs.length === 0) {
      return step(kind, {
        status: "none",
        detail:
          kind === "tests"
            ? "the project card has no test command, so nothing was tested"
            : `the project card has no ${kind} command`,
      });
    }
    const many = task.repos.length > 1;
    let total = 0;
    let counted = 0;
    let countedAny = false;
    for (const r of runs) {
      const where = many ? ` in ${r.project}` : "";
      const caps = await this.ports.limits?.(r.project);
      const timeoutMs =
        kind !== "lint" && caps?.minutes !== undefined ? caps.minutes * MINUTE : this.timeouts[kind];
      const more =
        kind === "lint"
          ? ""
          : `. To allow more, set containers.handoff_minutes.${r.project} (now ${Math.round(timeoutMs / MINUTE)}) or containers.handoff_cpus${caps === undefined ? "" : ` (now ${caps.cpus})`}`;
      const limits = caps === undefined ? undefined : { cpus: caps.cpus, memory: caps.memory };
      const run = () => this.ports.exec(task.id, r.cwd, r.command, timeoutMs, limits);
      let res = await run();
      total += res.ms;
      if (res.error !== undefined) {
        return step(kind, {
          status: "fail",
          detail: `${r.command} could not run${where}: ${res.error}`,
          ms: total,
          owner: true,
        });
      }
      if (res.timedOut) {
        return step(kind, {
          status: "timeout",
          detail: `\`${r.command}\` did not finish in ${handoffSeconds(timeoutMs)}${where}, so it was stopped${more}`,
          ms: total,
          output: outputTail(res.output),
        });
      }
      if (res.code !== 0) {
        const first = res;
        if (kind === "tests") {
          res = await run();
          total += res.ms;
          if (res.error === undefined && !res.timedOut && res.code === 0) {
            return step(kind, {
              status: "flaky",
              detail: `\`${r.command}\` failed, then passed on a retry${where}: flaky, so not green`,
              ms: total,
              output: outputTail(first.output),
            });
          }
        }
        return step(kind, {
          status: res.timedOut ? "timeout" : "fail",
          detail: res.timedOut
            ? `\`${r.command}\` did not finish in ${handoffSeconds(timeoutMs)} on its retry${where}${more}`
            : `\`${r.command}\` failed${where} (exit ${res.code ?? "none"}, ${handoffSeconds(res.ms)}${kind === "tests" ? ", also on a retry" : ""})`,
          ms: total,
          output: outputTail(res.output),
        });
      }
      const n = passedCount(res.output);
      if (n !== undefined) {
        counted += n;
        countedAny = true;
      }
    }
    return step(kind, {
      status: "pass",
      detail: kind === "tests" && countedAny ? `${counted} passed` : "ok",
      ms: total,
    });
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
        why: "the model reads it when Autonomous is on or you press Check again",
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
    // "Checks fail: send the failures to the lead" is switched off: the lead is not told, and the card says why.
    const tells = this.ports.autonomous() && this.ports.ruleOff?.(task.org, "ship-checks") !== true;
    if (existing !== undefined) {
      if (force) this.repo.replaceHistory(task.id, item(existing.action), result);
      // Failed with Autonomous off before and it is on now: the lead is told, once, with no new strike.
      if (existing.action === "none" && !state.escalated && tells) {
        await this.tellLead(task, result, Math.max(1, state.strikes));
        return;
      }
      // The same head again: the card says why it is still not ready, and nobody is told twice.
      this.ports.hold(
        task.id,
        existing.action === "told"
          ? `Checks failed and nothing was committed since the lead was told: ${firstLine(result.failures)}`
          : `Checks failed${state.escalated ? ` ${state.strikes} times in a row` : ""}: ${firstLine(result.failures)}`,
      );
      return;
    }
    const strikes = state.strikes + 1;
    this.repo.addHistory(task.id, item("none"), result);
    if (!tells && this.ports.autonomous()) {
      this.ports.hold(task.id, `Checks failed: ${firstLine(result.failures)}`);
      return;
    }
    if (strikes >= HANDOFF_STRIKES || state.escalated) {
      this.repo.setState(task.id, strikes, true);
      this.repo.setAction(task.id, head, "escalated");
      this.ports.hold(
        task.id,
        `Checks failed ${strikes} times in a row, so the lead is not told again. The latest: ${firstLine(result.failures)}`,
      );
      return;
    }
    this.repo.setState(task.id, strikes, false);
    if (tells) await this.tellLead(task, result, strikes);
    else this.ports.hold(task.id, `Checks failed: ${firstLine(result.failures)}`);
  }

  private async tellLead(task: HandoffTask, result: HandoffResult, attempt: number): Promise<void> {
    try {
      await this.ports.tell(task.id, failureNote(result.failures, attempt, HANDOFF_STRIKES, result.head));
      this.repo.setAction(task.id, result.head, "told");
    } catch (err) {
      // No lead to tell (paused, done, no agent): the owner sees the failure on the card.
      this.ports.hold(
        task.id,
        `Checks failed and the lead could not be told (${errorMessage(err)}): ${firstLine(result.failures)}`,
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
function firstLine(failures: readonly string[]): string {
  const line = (failures[0] ?? "").split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}
