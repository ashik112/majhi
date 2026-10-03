import type {
  Authority,
  AutonomyMode,
  AutonomyOrg,
  CaptainCapAsk,
  CaptainCause,
  CaptainChore,
  CaptainRunStatus,
  CaptainUndo,
} from "@majhi/shared";
import { CHORE_LABEL } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import { choresNow } from "./levels.ts";
import { NEAR_SAME_MS, type PastAnswer } from "./question-loop.ts";
import type { CaptainRepo } from "./repo.ts";
import { capAskText, dailyCaps, FAILURES_OFF, RAISE_FACTOR, RUN_CAPS, runActions } from "./rules.ts";

/**
 * The guards every upkeep chore runs under (SPEC 5.18, "No runaway, no loops"). Structural, so a chore
 * cannot skip them: one run per chore and workspace (a trigger during a run joins it), hard caps per
 * run on actions, tokens and minutes, daily caps per chore, triggers the captain caused never start a
 * run, every action has a key so doing it twice changes nothing, the rules are read again right before
 * an irreversible step, two failures in a row turn the chore off and tell the owner, and the stop
 * switch ends everything.
 */

/** The workspace as the captain sees it right now. */
export interface Workspace {
  org: string;
  name: string;
  /** Autonomous now: only memory and cleanup run while it is not On. */
  mode: AutonomyMode;
  /** Who decides each row now (Autonomous applied: all "ask" but upkeep while it is not On). */
  authority: Authority;
  rules: AutonomyOrg | undefined;
  tz: string;
  /** Today in the workspace's zone. */
  day: string;
  /** Why it does nothing on its own right now (hours, a freeze). */
  rest?: string | undefined;
}

export interface RunnerDeps {
  repo: CaptainRepo;
  now: () => Date;
  /** Undefined: there is no such workspace, or no captain. */
  workspace(org: string): Promise<Workspace | undefined>;
  stopped(): boolean;
  /** Tells the owner through the bell. */
  tellOwner(org: string, text: string): void;
  /** Marks a subject (a task) as touched by the captain, so the events it causes start nothing. */
  caused(subject: string): void;
  /** Tokens the workspace's lane spent since `since`. */
  laneTokens(org: string, since: string): number;
  chores: Record<CaptainChore, (run: ChoreRun) => Promise<void>>;
  /** Something in the log or the runs changed. */
  changed?: () => void;
  /** A chore reached a daily cap with work left, and the owner is asked whether to raise it today. */
  capAsked?: (ask: CaptainCapAsk) => void;
}

/**
 * A chore reached a daily cap while it had work: the owner is asked once that day whether to raise
 * it. After a raise the raised cap holds for the rest of the day, with no second question.
 */
function askToRaise(
  deps: RunnerDeps,
  ws: Workspace,
  chore: CaptainChore,
  kind: CaptainCapAsk["kind"],
  cap: number,
): void {
  if (deps.repo.capRaised(ws.org, chore, ws.day)) return;
  const ask: CaptainCapAsk = {
    org: ws.org,
    chore,
    day: ws.day,
    kind,
    cap,
    raiseTo: cap * RAISE_FACTOR,
    text: capAskText(ws.name, chore, kind, cap),
    at: deps.now().toISOString(),
  };
  if (deps.repo.addCapAsk(ask)) deps.capAsked?.(ask);
}

/** Why a run ended before its chore finished. */
export class RunEnd extends Error {
  constructor(
    readonly status: Exclude<CaptainRunStatus, "running" | "done">,
    readonly why: string,
  ) {
    super(why);
  }
}

export interface ActInput {
  /** Doing the same key twice changes nothing: the second time is a repeat. */
  key: string;
  /** What it does, one line. Replaced by the result's `text` when the step gives one. */
  text: string;
  reason: string;
  evidence?: string | undefined;
  task?: string | undefined;
  /** A push, merge, request or post: the rules are read again right before it. */
  irreversible?: boolean | undefined;
  /** Read right before the step, after the workspace's own rules: why it may not go now. */
  recheck?: (() => Promise<string | undefined>) | undefined;
  do: () => Promise<StepResult>;
}

export interface StepResult {
  text?: string | undefined;
  /** `asked`: it handed the matter to the owner. Default `done`. */
  outcome?: "done" | "asked" | undefined;
  undo?: CaptainUndo | undefined;
  /** Why Undo is not possible. */
  undoNote?: string | undefined;
  evidence?: string | undefined;
}

export type ActOutcome = "done" | "asked" | "repeat" | "blocked" | "failed";

const MAX_PASSES = 3;

/** One run of one chore in one workspace. Chores act only through it. */
export class ChoreRun {
  private actions = 0;
  /** Triggers that joined while it ran. */
  readonly joined = new Set<string>();
  again = false;
  private readonly started: number;

  constructor(
    readonly id: number,
    readonly chore: CaptainChore,
    public ws: Workspace,
    private readonly deps: RunnerDeps,
    readonly startedAt: string,
  ) {
    this.started = Date.parse(startedAt);
  }

  get org(): string {
    return this.ws.org;
  }

  get count(): number {
    return this.actions;
  }

  /** Ends the run when it reached a cap or the captain was stopped. */
  check(): void {
    if (this.deps.stopped()) throw new RunEnd("stopped", "majhi is shutting down");
    const actions = runActions(this.chore);
    if (this.actions >= actions) {
      throw new RunEnd("capped", `reached its cap of ${actions} actions in one run`);
    }
    const minutes = (this.deps.now().getTime() - this.started) / 60_000;
    if (minutes >= RUN_CAPS.minutes) {
      throw new RunEnd("capped", `reached its cap of ${RUN_CAPS.minutes} minutes in one run`);
    }
    const tokens = this.deps.laneTokens(this.org, this.startedAt);
    if (tokens >= RUN_CAPS.tokens) {
      throw new RunEnd(
        "capped",
        `reached its cap of ${RUN_CAPS.tokens.toLocaleString("en-US")} tokens in one run`,
      );
    }
    const daily = dailyCaps(this.chore, this.deps.repo.capRaised(this.org, this.chore, this.ws.day)).actions;
    if (daily !== undefined && this.deps.repo.actionsToday(this.org, this.chore, this.ws.day) >= daily) {
      askToRaise(this.deps, this.ws, this.chore, "actions", daily);
      throw new RunEnd(
        "capped",
        `reached today's cap of ${daily} for ${CHORE_LABEL[this.chore].toLowerCase()}`,
      );
    }
  }

  /** Whether this key was acted on before, in any run. */
  done(key: string): boolean {
    return this.deps.repo.hasAction(key);
  }

  /** What the captain answered to `agent` in `task` in the last ten minutes, oldest first. */
  answeredRecently(task: string, agent: string): PastAnswer[] {
    const since = new Date(this.deps.now().getTime() - NEAR_SAME_MS).toISOString();
    const prefix = `Answered @${agent} in ${task}: `;
    return this.deps.repo.answersSince(this.org, task, agent, since).map((a) => ({
      at: a.at,
      question: a.evidence ?? "",
      answer: a.text.startsWith(prefix) ? a.text.slice(prefix.length) : undefined,
    }));
  }

  /** Takes one step under every guard. */
  async act(a: ActInput): Promise<ActOutcome> {
    this.check();
    if (this.deps.repo.hasAction(a.key)) return "repeat";
    if (a.irreversible === true || a.recheck !== undefined) {
      const why = await this.recheck(a);
      if (why !== undefined) {
        this.note(a.key, `Left ${a.task ?? "it"}: ${why}`, `Checked again right before: ${why}`, a.task);
        return "blocked";
      }
    }
    if (a.task !== undefined) this.deps.caused(a.task);
    const at = this.deps.now().toISOString();
    let result: StepResult;
    try {
      result = await a.do();
    } catch (err) {
      const error = errorMessage(err);
      this.deps.repo.addAction({
        key: `${a.key}:failed:${at}`,
        run: this.id,
        org: this.org,
        chore: this.chore,
        day: this.ws.day,
        at,
        text: `${a.text} failed: ${error}`,
        reason: a.reason,
        evidence: a.evidence,
        task: a.task,
        outcome: "failed",
      });
      this.deps.changed?.();
      const failures = this.deps.repo.failed(this.org, this.chore);
      if (failures >= FAILURES_OFF) {
        const why = `${failures} failures in a row, the last: ${error}`;
        this.deps.repo.turnOff(this.org, this.chore, at, why);
        this.deps.tellOwner(
          this.org,
          `${this.ws.name}: the captain turned "${CHORE_LABEL[this.chore]}" off after ${why}. Turn it on again on the Captain page.`,
        );
        throw new RunEnd("failed", `turned off after ${failures} failures in a row`);
      }
      return "failed";
    }
    this.deps.repo.succeeded(this.org, this.chore);
    const outcome = result.outcome ?? "done";
    const added = this.deps.repo.addAction({
      key: a.key,
      run: this.id,
      org: this.org,
      chore: this.chore,
      day: this.ws.day,
      at,
      text: result.text ?? a.text,
      reason: a.reason,
      evidence: result.evidence ?? a.evidence,
      task: a.task,
      outcome,
      undo: result.undo,
      undoNote: result.undoNote,
    });
    if (added === undefined) return "repeat";
    this.actions += 1;
    this.deps.repo.countRunAction(this.id);
    this.deps.changed?.();
    return outcome;
  }

  /** A line that it looked and left something, once per key and day. Counts toward nothing. */
  note(key: string, text: string, reason: string, task?: string): void {
    const added = this.deps.repo.addAction({
      key: `skip:${key}:${this.ws.day}`,
      run: this.id,
      org: this.org,
      chore: this.chore,
      day: this.ws.day,
      at: this.deps.now().toISOString(),
      text,
      reason,
      task,
      outcome: "skipped",
    });
    if (added !== undefined) this.deps.changed?.();
  }

  /** The workspace's rules read again, then the step's own check. */
  private async recheck(a: ActInput): Promise<string | undefined> {
    if (this.deps.stopped()) throw new RunEnd("stopped", "majhi is shutting down");
    const now = await this.deps.workspace(this.org);
    if (now === undefined || !choresNow(now.authority, now.mode).includes(this.chore)) {
      throw new RunEnd("stopped", "the workspace no longer lets the captain do this");
    }
    if (now.rest !== undefined) throw new RunEnd("rested", now.rest);
    this.ws = now;
    return a.recheck?.();
  }
}

/** Starts and joins runs. One per chore and workspace at a time. */
export class ChoreRunner {
  private readonly active = new Map<string, ChoreRun>();
  private readonly starting = new Set<string>();
  /** Triggers the captain caused, dropped. The soak test reads it. */
  selfDropped = 0;

  constructor(private readonly deps: RunnerDeps) {}

  /** A run is going or starting. */
  busy(): boolean {
    return this.active.size > 0 || this.starting.size > 0;
  }

  running(org: string, chore: CaptainChore): boolean {
    const key = `${org}:${chore}`;
    return this.active.has(key) || this.starting.has(key);
  }

  /**
   * Something happened that a chore should look at. The captain's own events start nothing; a
   * trigger while the chore runs in that workspace joins the run.
   */
  async trigger(t: {
    org: string;
    chore: CaptainChore;
    cause: CaptainCause;
    why: string;
    subject?: string | undefined;
  }): Promise<void> {
    if (t.cause === "captain") {
      this.selfDropped += 1;
      return;
    }
    await this.start(t.org, t.chore, t.why, t.subject);
  }

  /** Starts a run unless one runs, the chore is off or capped for today, or the workspace rests. */
  async start(
    org: string,
    chore: CaptainChore,
    why: string,
    subject?: string,
  ): Promise<CaptainRunStatus | undefined> {
    const { deps } = this;
    if (deps.stopped()) return undefined;
    const key = `${org}:${chore}`;
    const active = this.active.get(key);
    if (active !== undefined) {
      if (subject !== undefined) active.joined.add(subject);
      active.again = true;
      return undefined;
    }
    if (this.starting.has(key)) return undefined;
    this.starting.add(key);
    let run: ChoreRun | undefined;
    try {
      const ws = await deps.workspace(org);
      if (ws === undefined || !choresNow(ws.authority, ws.mode).includes(chore) || ws.rest !== undefined)
        return undefined;
      if (deps.repo.chore(org, chore).offAt !== undefined) return undefined;
      const runs = dailyCaps(chore, deps.repo.capRaised(org, chore, ws.day)).runs;
      if (runs !== undefined && deps.repo.runsToday(org, chore, ws.day) >= runs) {
        askToRaise(deps, ws, chore, "runs", runs);
        return undefined;
      }
      const at = deps.now().toISOString();
      const id = deps.repo.openRun({ org, chore, day: ws.day, at, trigger: why });
      if (id === undefined) return undefined;
      run = new ChoreRun(id, chore, ws, deps, at);
      if (subject !== undefined) run.joined.add(subject);
      this.active.set(key, run);
    } finally {
      this.starting.delete(key);
    }
    return this.drive(key, run);
  }

  private async drive(key: string, run: ChoreRun): Promise<CaptainRunStatus> {
    const { deps } = this;
    let status: Exclude<CaptainRunStatus, "running"> = "done";
    let note: string | undefined;
    try {
      let passes = 0;
      do {
        run.again = false;
        passes += 1;
        await deps.chores[run.chore](run);
      } while (run.again && passes < MAX_PASSES);
    } catch (err) {
      if (err instanceof RunEnd) {
        status = err.status;
        note = err.why;
      } else {
        status = "failed";
        note = errorMessage(err);
        const failures = deps.repo.failed(run.org, run.chore);
        if (failures >= FAILURES_OFF) {
          const why = `${failures} failures in a row, the last: ${note}`;
          deps.repo.turnOff(run.org, run.chore, deps.now().toISOString(), why);
          deps.tellOwner(
            run.org,
            `${run.ws.name}: the captain turned "${CHORE_LABEL[run.chore]}" off after ${why}. Turn it on again on the Captain page.`,
          );
        }
      }
    } finally {
      this.active.delete(key);
    }
    const at = deps.now().toISOString();
    deps.repo.setRunTokens(run.id, deps.laneTokens(run.org, run.startedAt));
    deps.repo.closeRun(run.id, status, at, note);
    if (status === "capped" || status === "stopped" || status === "failed") {
      deps.repo.addAction({
        key: `run:${run.id}:end`,
        run: run.id,
        org: run.org,
        chore: run.chore,
        day: run.ws.day,
        at,
        text: `${CHORE_LABEL[run.chore]} stopped: ${note ?? status}`,
        reason: status === "capped" ? "Every run stops at its cap" : (note ?? status),
        outcome: "skipped",
      });
    }
    deps.changed?.();
    return status;
  }

  /** "Stop the captain": runs end at their next step. */
  openRuns(): ChoreRun[] {
    return [...this.active.values()];
  }
}
