import { type AutomationRun, nextRunAfter } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import type { ActionRunner } from "./actions.ts";
import type { ScheduleRepo, ScheduleRow } from "./schedules.ts";

/** The longest the loop sleeps. It also ends runs whose task or process finished meanwhile. */
export const MAX_WAIT_MS = 60_000;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface SchedulerDeps {
  repo: ScheduleRepo;
  runner: ActionRunner;
  /** The clock. Tests move it. */
  now?: () => Date;
  timers?: Timers;
  /** Something about a schedule changed: its next run, its last run or its state. */
  changed?: () => void;
  onError?: (message: string) => void;
}

/**
 * The run loop. One timer, set to the earliest `next_run_at` but never more than a minute out, so
 * there is no polling per schedule. A schedule that is due runs once, however many slots it
 * missed: its next slot is counted from now. That is also how a restart catches up.
 */
export class Scheduler {
  private readonly now: () => Date;
  private readonly timers: Timers;
  private handle: unknown;
  private running = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timers = deps.timers ?? realTimers;
  }

  /** Catches up on what was missed while majhi was down, then keeps time. */
  start(): void {
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = undefined;
  }

  /** Sets the timer again after a schedule was added, edited or resumed. */
  arm(): void {
    if (!this.running) return;
    if (this.handle !== undefined) this.timers.clear(this.handle);
    const next = this.deps.repo.earliest();
    const wait = next === undefined ? MAX_WAIT_MS : Date.parse(next) - this.now().getTime();
    this.handle = this.timers.set(() => void this.tick(), Math.min(MAX_WAIT_MS, Math.max(0, wait)));
  }

  /** Runs everything due, ends finished runs, and sets the timer. Calls queue behind each other. */
  tick(): Promise<void> {
    const turn = this.chain.then(() => this.tickNow());
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  private async tickNow(): Promise<void> {
    try {
      await this.deps.runner.reconcile();
      const now = this.now();
      for (const schedule of this.deps.repo.due(now.toISOString())) {
        try {
          await this.fire(schedule, now);
        } catch (err) {
          this.deps.onError?.(`Schedule ${schedule.id} failed: ${errorMessage(err)}`);
        }
      }
      this.deps.changed?.();
    } catch (err) {
      this.deps.onError?.(`The scheduler could not tick: ${errorMessage(err)}`);
    } finally {
      this.arm();
    }
  }

  /** A due run. The next slot is saved first, so a crash mid-run cannot run the slot twice. */
  private async fire(schedule: ScheduleRow, now: Date): Promise<void> {
    const next = nextRunAfter(schedule.spec, schedule.timeZone, now);
    this.deps.repo.update(
      schedule.id,
      { nextRunAt: next?.toISOString() ?? null, done: next === undefined },
      now.toISOString(),
    );
    await this.execute(schedule);
  }

  /** Runs the schedule's action under its overlap rule, and remembers the run as its last. */
  async execute(schedule: ScheduleRow): Promise<AutomationRun> {
    const run = await this.deps.runner.run(
      { kind: "schedule", id: schedule.id, org: schedule.org, name: schedule.name },
      schedule.action,
      schedule.overlap,
    );
    this.deps.repo.update(schedule.id, { lastRunId: run.id }, this.now().toISOString());
    this.deps.changed?.();
    return run;
  }
}
