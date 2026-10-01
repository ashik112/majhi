import { type AutomationAction, type AutomationRun, defaultPollSeconds } from "@majhi/shared";
import { errorMessage } from "../../errors.ts";
import type { ActionRunner } from "../actions.ts";
import { realTimers, type Timers } from "../scheduler.ts";
import { describeEvent, isCondition, type Observation, type Observer, OFF, ON } from "./observe.ts";
import type { Baseline, TriggerRepo, TriggerRow } from "./repo.ts";

/** How often the engine looks for triggers that are due. A trigger is checked at its own pace. */
export const TICK_MS = 5_000;

export interface EngineDeps {
  repo: TriggerRepo;
  runner: ActionRunner;
  observer: Observer;
  /** The clock. Tests move it. */
  now?: () => Date;
  timers?: Timers;
  /** A trigger fired, ran into a problem or got its first look. */
  changed?: () => void;
  onError?: (message: string) => void;
}

/** What the engine holds in memory about a trigger. None of it has to survive a restart. */
export interface TriggerState {
  lastCheckedAt: string | null;
  checkError: string | null;
  /** A change was seen and waits for the settle time or the cooldown. */
  pending: boolean;
}

/** `{{event}}` in the text of an action, so a message or a task can say what happened. */
export function withEvent(action: AutomationAction, event: string): AutomationAction {
  const fill = (text: string): string => text.split("{{event}}").join(event);
  switch (action.kind) {
    case "room.post":
      return { ...action, text: fill(action.text) };
    case "task.start":
      return { ...action, title: fill(action.title), text: fill(action.text) };
    case "process.run":
      // A command is never filled in: what matched may hold anything a repo or a page says.
      return action;
  }
}

/**
 * Checks watch triggers and runs their actions. A trigger remembers what it last saw (its
 * baseline, kept in the database). A check that sees something different which counts as a match
 * waits until the change has held still for the settle time and the cooldown after the last
 * firing is over, then fires once, however many changes came in between. A restart compares with
 * the baseline, so a change made while majhi was down fires once and nothing fires twice.
 */
export class TriggerEngine {
  private readonly now: () => Date;
  private readonly timers: Timers;
  private handle: unknown;
  private running = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly lastChecked = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  /** A change that waits: its key says which, and `since` is when it last changed. */
  private readonly pending = new Map<string, { key: string; since: number }>();
  /** Bumped when a trigger is edited, paused or deleted, so a check that was looking drops its result. */
  private readonly epochs = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timers = deps.timers ?? realTimers;
  }

  /** Looks at every trigger now, which is how a restart catches up, then keeps looking. */
  start(): void {
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = undefined;
  }

  /** What the engine knows about a trigger that the database does not. */
  state(id: string): TriggerState {
    const at = this.lastChecked.get(id);
    return {
      lastCheckedAt: at === undefined ? null : new Date(at).toISOString(),
      checkError: this.errors.get(id) ?? null,
      pending: this.pending.has(id),
    };
  }

  /** A trigger was edited, paused, resumed or deleted: what was seen no longer applies. */
  forget(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.lastChecked.delete(id);
    this.errors.delete(id);
    this.pending.delete(id);
    this.deps.observer.forget(id);
  }

  /** Checks the triggers that are due. Calls queue behind each other. */
  tick(): Promise<void> {
    const turn = this.chain.then(() => this.tickNow());
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  private async tickNow(): Promise<void> {
    try {
      const now = this.now();
      const due = this.deps.repo.active().filter((row) => {
        const last = this.lastChecked.get(row.id);
        return (
          !this.inFlight.has(row.id) &&
          (last === undefined || now.getTime() - last >= pollSeconds(row) * 1000)
        );
      });
      const results = await Promise.all(due.map((row) => this.check(row, now)));
      if (results.some(Boolean)) this.deps.changed?.();
    } catch (err) {
      this.deps.onError?.(`The trigger engine could not tick: ${errorMessage(err)}`);
    } finally {
      this.arm();
    }
  }

  private arm(): void {
    if (!this.running) return;
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = this.timers.set(() => void this.tick(), TICK_MS);
  }

  /** One check. True when something worth showing changed. */
  private async check(row: TriggerRow, now: Date): Promise<boolean> {
    const epoch = this.epochs.get(row.id) ?? 0;
    this.inFlight.add(row.id);
    this.lastChecked.set(row.id, now.getTime());
    try {
      let obs: Observation | undefined;
      try {
        obs = await this.deps.observer.observe(row, row.watch);
      } catch (err) {
        const message = errorMessage(err);
        const changed = this.errors.get(row.id) !== message;
        if ((this.epochs.get(row.id) ?? 0) === epoch) this.errors.set(row.id, message);
        return changed;
      }
      if ((this.epochs.get(row.id) ?? 0) !== epoch) return false;
      const hadError = this.errors.delete(row.id);
      if (obs === undefined) return hadError;
      return (await this.compare(row, obs, now)) || hadError;
    } catch (err) {
      this.deps.onError?.(`Trigger ${row.id} failed: ${errorMessage(err)}`);
      return false;
    } finally {
      this.inFlight.delete(row.id);
    }
  }

  /** Sets what was seen against the baseline, and fires when a match has settled. */
  private async compare(row: TriggerRow, obs: Observation, now: Date): Promise<boolean> {
    const { repo } = this.deps;
    const baseline = row.baseline;
    if (baseline === null) {
      // The first look sets what later looks are compared with. Nothing fires for what was already so.
      repo.update(row.id, { baseline: obs.states });
      return true;
    }
    const condition = isCondition(row.watch.kind);
    const next: Baseline = {};
    const matched: Record<string, string> = {};
    for (const [subject, state] of Object.entries(obs.states)) {
      const before = baseline[subject] ?? (condition ? OFF : undefined);
      if (before === state) {
        next[subject] = state;
      } else if (condition ? state === ON : true) {
        matched[subject] = state;
        // What matched stays as it was until the trigger fires, so a wait does not lose it.
        const kept = baseline[subject];
        if (kept !== undefined) next[subject] = kept;
      } else {
        next[subject] = state;
      }
    }
    if (JSON.stringify(sorted(next)) !== JSON.stringify(sorted(baseline)))
      repo.update(row.id, { baseline: next });
    const subjects = Object.keys(matched).sort();
    if (subjects.length === 0) {
      this.pending.delete(row.id);
      return false;
    }
    const key = JSON.stringify(subjects.map((s) => [s, matched[s]]));
    let waiting = this.pending.get(row.id);
    if (waiting?.key !== key) {
      waiting = { key, since: now.getTime() };
      this.pending.set(row.id, waiting);
    }
    if (now.getTime() - waiting.since < row.settleSeconds * 1000) return false;
    if (
      row.lastFiredAt !== null &&
      now.getTime() - Date.parse(row.lastFiredAt) < row.cooldownSeconds * 1000
    ) {
      return false;
    }
    // The baseline moves before the run, so a crash in it cannot fire the same change twice.
    repo.update(row.id, { baseline: { ...next, ...matched }, lastFiredAt: now.toISOString() });
    this.pending.delete(row.id);
    await this.run(row, describeEvent(obs, subjects));
    return true;
  }

  /** Runs the trigger's action under its overlap rule, and remembers the run as its last. */
  async run(row: TriggerRow, event: string): Promise<AutomationRun> {
    const run = await this.deps.runner.run(
      { kind: "trigger", id: row.id, org: row.org, name: row.name },
      withEvent(row.action, event),
      row.overlap,
    );
    this.deps.repo.update(row.id, { lastRunId: run.id });
    this.deps.changed?.();
    return run;
  }
}

function pollSeconds(row: TriggerRow): number {
  return row.pollSeconds ?? defaultPollSeconds(row.watch.kind);
}

function sorted(baseline: Baseline): [string, string][] {
  return Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b));
}
