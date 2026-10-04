import type {
  Authority,
  AutonomyMode,
  AutonomyOrg,
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
import { FAILURES_OFF, PASS_BOUND } from "./rules.ts";

/**
 * The guards every upkeep chore runs under (SPEC 5.18, "No runaway, no loops"). Structural, so a chore
 * cannot skip them: one run per chore and workspace (a trigger during a run joins it), one bound per
 * pass (`PASS_BOUND`: minutes or tokens), triggers the captain caused never start a run, every action
 * has a key of the state it acts on so doing it twice changes nothing (G1), the rules are read again
 * right before an irreversible step, two failures in a row turn the chore off and tell the owner, and
 * the stop switch ends everything.
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
  /** Outcome rules the owner switched off in the chore's playbook (`ship-merge`, ...). Each stops that action. */
  rulesOff?: ReadonlySet<string> | undefined;
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
  /** The chore's playbook: a chore the owner turned off never starts, by schedule, event or click. */
  enabled?: (org: string, chore: CaptainChore) => boolean;
  /** Something in the log or the runs changed. */
  changed?: () => void;
  /** A run ended: the chore did `did` things. The playbook's "Or do this" follows. */
  afterRun?: (org: string, chore: CaptainChore, did: number) => void;
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
  /** The state was acted on already (another path answered the card first): no line, a repeat. */
  repeat?: true | undefined;
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

  /** Ends the run when it reached the pass bound or the captain was stopped. */
  check(): void {
    if (this.deps.stopped()) throw new RunEnd("stopped", "majhi is shutting down");
    const minutes = (this.deps.now().getTime() - this.started) / 60_000;
    if (minutes >= PASS_BOUND.minutes) {
      throw new RunEnd("capped", `reached its bound of ${PASS_BOUND.minutes} minutes in one run`);
    }
    const tokens = this.deps.laneTokens(this.org, this.startedAt);
    if (tokens >= PASS_BOUND.tokens) {
      throw new RunEnd(
        "capped",
        `reached its bound of ${PASS_BOUND.tokens.toLocaleString("en-US")} tokens in one run`,
      );
    }
  }

  /** Whether this key was acted on before, in any run. */
  done(key: string): boolean {
    return this.deps.repo.hasAction(key);
  }

  /** How many times a key starting with `prefix` was acted on, in any run. */
  times(prefix: string): number {
    return this.deps.repo.countActions(prefix);
  }

  /** What the captain answered to `agent` in `task` in the last ten minutes, oldest first. */
  answeredRecently(task: string, agent: string): PastAnswer[] {
    const since = new Date(this.deps.now().getTime() - NEAR_SAME_MS).toISOString();
    const prefix = `Answered @${agent} in ${task}: `;
    return this.deps.repo.answersSince(this.org, task, agent, since).map((a) => ({
      at: a.at,
      question: a.evidence ?? "",
      // The action's key ends in the card's item id: `question:<task>:<item>` or `own:<task>:<item>`.
      item: a.key.split(`:${task}:`)[1],
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
    // The key is taken before the step, in one insert: the lane may be shipping the same state now.
    if (this.deps.repo.claimKey("chore", a.key, a.task, at) !== "taken") return "repeat";
    let result: StepResult;
    try {
      result = await a.do();
    } catch (err) {
      this.deps.repo.releaseKey(a.key);
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
    if (result.repeat === true) {
      this.deps.repo.releaseKey(a.key);
      return "repeat";
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
    // The log line holds the key now.
    this.deps.repo.releaseKey(a.key);
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
    const begun = await this.begin(org, chore, why, subject);
    if (begun.run === undefined) return undefined;
    return this.drive(begun.key, begun.run);
  }

  /**
   * The owner's "Review now": one run now, whatever the schedule. It still stops for a run that is
   * going, a chore turned off, a rest and the pass bound. `done` settles when the run ends.
   */
  async startNow(
    org: string,
    chore: CaptainChore,
  ): Promise<{ ran: false; why: string } | { ran: true; done: Promise<CaptainRunStatus> }> {
    const begun = await this.begin(org, chore, "The owner asked for it", undefined);
    if (begun.run === undefined) return { ran: false, why: begun.why ?? "It did not start." };
    return { ran: true, done: this.drive(begun.key, begun.run) };
  }

  private async begin(
    org: string,
    chore: CaptainChore,
    why: string,
    subject: string | undefined,
  ): Promise<{ key: string; run?: ChoreRun; why?: string }> {
    const { deps } = this;
    const key = `${org}:${chore}`;
    const no = (reason: string) => ({ key, why: reason });
    if (deps.stopped()) return no("majhi is shutting down");
    const active = this.active.get(key);
    if (active !== undefined) {
      if (subject !== undefined) active.joined.add(subject);
      active.again = true;
      return no(`${CHORE_LABEL[chore]} is already running here.`);
    }
    if (this.starting.has(key)) return no(`${CHORE_LABEL[chore]} is already starting here.`);
    this.starting.add(key);
    let run: ChoreRun | undefined;
    try {
      const ws = await deps.workspace(org);
      if (ws === undefined) return no("There is no such workspace, or no captain yet.");
      if (!choresNow(ws.authority, ws.mode).includes(chore)) {
        return no(`${CHORE_LABEL[chore]} is not on in ${ws.name}. Turn upkeep on in Delegation.`);
      }
      if (deps.enabled?.(org, chore) === false) {
        return no(`${CHORE_LABEL[chore]} is turned off in ${ws.name}. Turn it on in Playbooks.`);
      }
      if (ws.rest !== undefined) return no(`${ws.name} is resting: ${ws.rest}`);
      const off = deps.repo.chore(org, chore).offAt;
      if (off !== undefined)
        return no(`${CHORE_LABEL[chore]} was turned off after failures. Turn it on first.`);
      const at = deps.now().toISOString();
      const id = deps.repo.openRun({ org, chore, day: ws.day, at, trigger: why });
      if (id === undefined) return no(`${CHORE_LABEL[chore]} is already running here.`);
      run = new ChoreRun(id, chore, ws, deps, at);
      if (subject !== undefined) run.joined.add(subject);
      this.active.set(key, run);
    } finally {
      this.starting.delete(key);
    }
    return { key, run };
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
        reason: status === "capped" ? "Every run stops at its bound" : (note ?? status),
        outcome: "skipped",
      });
    }
    if (status === "done" && run.count > 0) deps.afterRun?.(run.org, run.chore, run.count);
    deps.changed?.();
    return status;
  }

  /** "Stop the captain": runs end at their next step. */
  openRuns(): ChoreRun[] {
    return [...this.active.values()];
  }
}
