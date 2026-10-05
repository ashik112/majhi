import { lifecycle, type PausedReason } from "@majhi/shared";
import type { LifecycleRows, LoadedRow } from "./rows.ts";
import { DURABLE, type EffectContext, type EffectKind, type OutboxItem } from "./types.ts";

type Effect = lifecycle.Effect;
type Hold = lifecycle.Hold;
type TaskState = lifecycle.TaskState;
type LifecycleEvent = lifecycle.LifecycleEvent;
type Refusal = lifecycle.Refusal;

/** Runs one effect of a transition. `before` and `after` are the task's state around the event. */
export interface EffectRunner {
  run(
    id: string,
    effect: Effect,
    ctx: EffectContext,
    states: { before: TaskState; after: TaskState },
  ): Promise<void>;
}

export interface LifecycleDeps {
  rows: LifecycleRows;
  runner: EffectRunner;
  now: () => Date;
  /** Dependencies the task still waits for. Read only for `start`. */
  unmetDeps: (id: string) => readonly string[];
  /** A run of the task is live. */
  hasLiveRun: (id: string) => boolean;
}

export interface ApplyOptions {
  /** Who is recorded as acting in the audit trail. Default: the context's `by`. */
  actor?: string | undefined;
  ctx?: Partial<EffectContext> | undefined;
  /** Effects the caller runs itself, because it needs them at another point (before a write, or with its own words). */
  skip?: readonly EffectKind[] | undefined;
  /**
   * What the old fields cannot say. A pause by the run gate is stored like an owner's stop (paused,
   * reason `owner`), and the caller that holds the gate's row knows which it is. Replaces an
   * `owner-stop` read from the row; any other hold is left as stored.
   */
  holdAs?: Hold | undefined;
}

export interface Applied {
  applied: true;
  eventId: number;
  before: TaskState;
  after: TaskState;
  /** Everything the transition asked for, the skipped ones too. */
  effects: Effect[];
}

export type Outcome = Applied | Refusal;

export const wasRefused = (o: Outcome): o is Refusal => "refused" in o;

/** The model's state of a stored row. `paused` becomes its lane plus a hold. */
function stateOf(
  id: string,
  row: LoadedRow,
  extra: { unmetDeps: readonly string[]; hasLiveRun: boolean },
): TaskState {
  const lc = lifecycle.fromStored(row.stored, { at: row.at, resumedAt: row.stored.resumedAt });
  return {
    id,
    status: lc.status,
    hold: lc.hold,
    startWhenReady: row.startWhenReady,
    hasLiveRun: extra.hasLiveRun,
    unmetDeps: extra.unmetDeps,
    exemptUntilRunEnds: lc.exemptUntilRunEnds,
  };
}

/**
 * The one way a task's status or hold changes (docs/design/task-lifecycle.md 4.5). It loads the
 * state, asks the pure `transition`, and then either records the refusal and writes nothing else, or
 * in one transaction writes the new state to today's columns, the audit row and the outbox. Only
 * then do the effects run, each of them idempotent, the ones that must not be lost from the outbox.
 *
 * No per-task lock: the state phase is synchronous (one SQLite transaction on one connection), so two
 * events cannot interleave in it, and holding a lock across effects would deadlock the effects that
 * report back (a run that stops calls `apply` again).
 */
export class TaskLifecycle {
  constructor(private readonly deps: LifecycleDeps) {}

  /** The model's view of a task right now, or undefined when it does not exist. */
  state(id: string, withDeps = false): TaskState | undefined {
    const row = this.deps.rows.load(id);
    if (row === undefined) return undefined;
    return stateOf(id, row, {
      unmetDeps: withDeps ? this.deps.unmetDeps(id) : [],
      hasLiveRun: this.deps.hasLiveRun(id),
    });
  }

  /** The row as stored, for building a hold from what a run reports. */
  load(id: string): LoadedRow | undefined {
    return this.deps.rows.load(id);
  }

  async apply(id: string, event: LifecycleEvent, options: ApplyOptions = {}): Promise<Outcome> {
    const ctx: EffectContext = { by: "majhi", ...options.ctx };
    const actor = options.actor ?? ctx.by;
    const at = this.deps.now().toISOString();
    const row = this.deps.rows.load(id);
    if (row === undefined)
      return { refused: true, code: "nothing-to-do", text: `Task ${id} does not exist.` };
    const read = stateOf(id, row, {
      unmetDeps: event.type === "start" ? this.deps.unmetDeps(id) : [],
      hasLiveRun: this.deps.hasLiveRun(id),
    });
    const before =
      options.holdAs !== undefined && read.hold?.cause === "owner-stop"
        ? { ...read, hold: options.holdAs }
        : read;
    const out = lifecycle.transition(before, event);
    if (lifecycle.isRefusal(out)) {
      this.deps.rows.refuse({
        id,
        event: event.type,
        actor,
        at,
        status: before.status,
        hold: before.hold,
        code: out.code,
        text: out.text,
      });
      return out;
    }
    const skip = new Set(options.skip ?? []);
    const toRun = out.effects.filter((e) => !skip.has(e.kind));
    const outbox: OutboxItem[] = toRun.filter((e) => DURABLE.has(e.kind)).map((effect) => ({ effect, ctx }));
    const eventId = this.deps.rows.commit({
      id,
      event: event.type,
      actor,
      at,
      before: { status: before.status, hold: before.hold },
      after: {
        status: out.next.status,
        hold: out.next.hold,
        exemptUntilRunEnds: out.next.exemptUntilRunEnds,
      },
      startWhenReady: out.next.startWhenReady,
      loaded: row,
      outbox,
    });
    await this.runAll(id, eventId, toRun, ctx, { before, after: out.next }, outbox);
    return { applied: true, eventId, before, after: out.next, effects: out.effects };
  }

  /**
   * Runs the effects in order. One that fails leaves itself and the durable ones after it in the
   * outbox, and the error goes to the caller. Done: the outbox row is cleared.
   */
  private async runAll(
    id: string,
    eventId: number,
    effects: readonly Effect[],
    ctx: EffectContext,
    states: { before: TaskState; after: TaskState },
    outbox: readonly OutboxItem[],
  ): Promise<void> {
    let done = 0;
    for (const effect of effects) {
      try {
        await this.deps.runner.run(id, effect, ctx, states);
      } catch (err) {
        if (outbox.length > 0) {
          // The durable effects not run yet: this one and every durable one after it.
          const left = effects.slice(effects.indexOf(effect)).filter((e) => DURABLE.has(e.kind));
          this.deps.rows.settle(eventId, outbox.slice(outbox.length - left.length));
        }
        throw err;
      }
      done++;
    }
    if (outbox.length > 0 && done === effects.length) this.deps.rows.settle(eventId, []);
  }

  /**
   * After a restart: runs the effects an event left in the outbox. An event with a newer one behind
   * it is out of date (the task moved on), so its effects are dropped, not run. Returns how many events it
   * ran.
   */
  async drain(): Promise<number> {
    let ran = 0;
    for (const row of this.deps.rows.pending()) {
      if (this.deps.rows.superseded(row.task, row.id)) {
        this.deps.rows.settle(row.id, []);
        continue;
      }
      const row0 = this.deps.rows.load(row.task);
      if (row0 === undefined) {
        this.deps.rows.settle(row.id, []);
        continue;
      }
      const state = stateOf(row.task, row0, { unmetDeps: [], hasLiveRun: this.deps.hasLiveRun(row.task) });
      try {
        for (const item of row.items) {
          await this.deps.runner.run(row.task, item.effect, item.ctx, { before: state, after: state });
        }
        this.deps.rows.settle(row.id, []);
        ran++;
      } catch {
        // Stays in the outbox for the next start.
      }
    }
    return ran;
  }
}

/** The hold a run's reported pause stands for, in the old words (`reason`) the run still speaks. */
export function holdFromRunReason(
  reason: "offline" | "error" | "limit" | "owner" | "signed-out",
  at: string,
  row: LoadedRow,
  why?: string,
): Hold {
  const gate = row.gate;
  return lifecycle.fromStored(
    {
      status: "paused",
      pausedReason: reason,
      // The run gate's own cap hold names the scope it held for. An owner pause from the gate is the
      // owner's stop in the old fields too (no `held`), so only a `limit` carries the gate's mark.
      held: reason === "limit" && gate?.held === "limit" ? "limit" : undefined,
      heldScope: reason === "limit" && gate?.held === "limit" ? gate.scope : undefined,
    },
    { at, phase: "turn", error: (why ?? "").slice(0, 2000) },
  ).hold as Hold;
}

/** Old pause reason of a hold, for the paused card (it still speaks the old words). */
export function pausedReasonOf(hold: Hold): PausedReason {
  const fields = lifecycle.toStored(
    { status: "running", hold, exemptUntilRunEnds: false },
    { at: "" },
  ).fields;
  return fields.pausedReason ?? "owner";
}

/**
 * A reading in which the hold's own condition holds. For callers that checked the world themselves
 * before they lift (the captain's resume rules, the limit resume): until the tick reads the sensors
 * and lifts holds itself (step F), their check is the proof, and this reading is how they say so.
 */
export function assertedReading(hold: Hold, now: string): lifecycle.ClearReading {
  return {
    now,
    online: true,
    accounts: "account" in hold ? { [hold.account]: { signedIn: true } } : {},
    budgetHasRoom: true,
    autopilot: "on",
    runAtStep: true,
    lastActivityAt: "9999-12-31T23:59:59.999Z",
  };
}
