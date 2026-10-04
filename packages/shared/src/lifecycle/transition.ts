import { z } from "zod";
import {
  autoClears,
  type ClearReading,
  conditionMet,
  type Hold,
  type Lifter,
  liftersOf,
  mergeHold,
  sentenceOf,
} from "./hold.ts";

/**
 * The pure core of the task lifecycle (docs/design/task-lifecycle.md, 4.1 and 4.4). No I/O, no
 * clock (time arrives on the event), no randomness. A caller persists `next` and runs `effects`.
 *
 * Not yet used by any caller (step B): `TaskStatusSchema` in `tasks.ts` still has `paused`.
 */

/** Status is pure lifecycle. A task that is not moving keeps its lane and carries a hold. */
export const LifecycleStatusSchema = z.enum(["inbox", "ready", "running", "review", "mr", "done"]);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

export interface TaskState {
  id: string;
  status: LifecycleStatus;
  /** At most one: the cause that keeps it from moving. */
  hold: Hold | undefined;
  /** The owner's wish only: start when the dependencies are met. */
  startWhenReady: boolean;
  /** Filled by `apply()`, read-only for the core. */
  hasLiveRun: boolean;
  unmetDeps: readonly string[];
  /** The owner lifted a budget hold by hand: the gate lets the run go on until it ends. */
  exemptUntilRunEnds: boolean;
}

export type LifecycleEvent =
  | { type: "create"; id: string; status: "inbox" | "ready"; startWhenReady?: boolean }
  | { type: "wishStart" }
  | { type: "start"; by: Lifter }
  | { type: "sendBack"; by: Lifter }
  | { type: "ownerStop"; at: string }
  | { type: "captainStop"; at: string; why?: string }
  | { type: "autopilotOff"; at: string; mode: "now" | "step" }
  | { type: "autopilotOn"; resume: boolean; at: string }
  | { type: "runPaused"; hold: Hold }
  | { type: "runResumed" }
  | { type: "holdPlaced"; hold: Hold }
  | { type: "holdCleared"; by: "owner" | "captain" }
  /** majhi lifts on its own: the reading proves the hold's typed condition. */
  | { type: "holdCleared"; by: "majhi"; reading: ClearReading }
  | { type: "agentsIdle" }
  | { type: "processEnded" }
  | { type: "changeAndReview" }
  | { type: "mrOpened" }
  | { type: "mrClosedUnmerged" }
  | { type: "close" }
  | { type: "reopen"; to: "review" | "inbox" }
  | {
      type: "dependencyChanged";
      change: "closed-unmerged" | "removed" | "met";
      on: readonly string[];
      at: string;
    }
  | { type: "runLost"; at: string; autoResume: boolean };

export type LifecycleEventType = LifecycleEvent["type"];

export type Effect =
  | { kind: "card"; card: "paused" | "settle" | "review" | "mr" | "done"; text?: string }
  | { kind: "runs.stop" }
  | { kind: "runs.start"; ownBrief?: boolean }
  | { kind: "containers"; op: "stop" | "runAgain" }
  | { kind: "processes.stop" }
  | { kind: "terminals.stop" }
  | { kind: "parkServices" }
  | { kind: "dropPendingShip"; why: string }
  | { kind: "ensureWorktrees" }
  | { kind: "startWhenReady"; set: boolean }
  | { kind: "budgets.exempt" }
  | { kind: "publishTask" }
  | { kind: "statusChanged" };

export type RefusalCode =
  | "wrong-status"
  | "held"
  | "unmet-dependencies"
  | "not-held"
  | "not-allowed"
  | "condition-not-met"
  | "already-exists"
  | "nothing-to-do";

export interface Refusal {
  refused: true;
  code: RefusalCode;
  text: string;
  next?: string;
}

export interface Transition {
  next: TaskState;
  effects: Effect[];
}

export const isRefusal = (r: Transition | Refusal): r is Refusal => "refused" in r;

const refuse = (code: RefusalCode, text: string, next?: string): Refusal => ({
  refused: true,
  code,
  text,
  ...(next === undefined ? {} : { next }),
});

const wrongStatus = (event: LifecycleEventType, task: TaskState): Refusal =>
  refuse("wrong-status", `A ${task.status} task cannot take "${event}".`);

const heldRefusal = (hold: Hold): Refusal => refuse("held", sentenceOf(hold), "Lift the hold first.");

const stopEffects = (why: string): Effect[] => [
  { kind: "runs.stop" },
  { kind: "containers", op: "stop" },
  { kind: "processes.stop" },
  { kind: "terminals.stop" },
  { kind: "dropPendingShip", why },
  { kind: "card", card: "paused" },
  { kind: "publishTask" },
];

const pausedEffects = (hold: Hold): Effect[] => [
  ...(hold.cause === "error"
    ? [{ kind: "dropPendingShip", why: "the task stopped on an error" } as const]
    : []),
  { kind: "parkServices" },
  { kind: "card", card: "paused" },
  { kind: "publishTask" },
  { kind: "statusChanged" },
];

/**
 * Sets a hold with `effects`. A hold that lost the merge changes nothing. A hold of the cause the
 * task already has refreshes its data and runs no effects again (repeating a stop is a no-op, G1),
 * except Auto-pilot stepping up from `step` to `now`.
 */
function place(task: TaskState, incoming: Hold, effects: (kept: Hold) => Effect[]): Transition {
  const kept = mergeHold(task.hold, incoming);
  if (kept === task.hold) return { next: task, effects: [] };
  const was = task.hold;
  const stepUp = was?.cause === "autopilot-off" && kept.cause === "autopilot-off" && was.mode !== kept.mode;
  if (was?.cause === kept.cause && !stepUp) return { next: { ...task, hold: kept }, effects: [] };
  return { next: { ...task, hold: kept }, effects: effects(kept) };
}

const IN_FLIGHT: readonly LifecycleStatus[] = ["running", "review"];

/**
 * One event on one task. `task` is undefined only for `create`. Returns the next state and the
 * effects to run after it is stored, or a Refusal when nothing may be written.
 */
export function transition(task: TaskState | undefined, event: LifecycleEvent): Transition | Refusal {
  const out = step(task, event);
  if (isRefusal(out)) return out;
  // The wish to start when ready only means something while the task still waits to start.
  const waiting = out.next.status === "inbox" || out.next.status === "ready";
  return waiting || !out.next.startWhenReady ? out : { ...out, next: { ...out.next, startWhenReady: false } };
}

function step(task: TaskState | undefined, event: LifecycleEvent): Transition | Refusal {
  if (task === undefined) {
    if (event.type !== "create")
      return refuse("wrong-status", `A task that does not exist cannot take "${event.type}".`);
    const wish = event.startWhenReady === true;
    return {
      next: {
        id: event.id,
        status: event.status,
        hold: undefined,
        startWhenReady: wish,
        hasLiveRun: false,
        unmetDeps: [],
        exemptUntilRunEnds: false,
      },
      effects: [...(wish ? [{ kind: "startWhenReady", set: true } as const] : []), { kind: "publishTask" }],
    };
  }

  switch (event.type) {
    case "create":
      return refuse("already-exists", `${task.id} already exists.`);

    case "wishStart":
      if (task.status !== "inbox" && task.status !== "ready") return wrongStatus(event.type, task);
      return {
        next: { ...task, status: "ready", startWhenReady: true },
        effects: [{ kind: "startWhenReady", set: true }, { kind: "publishTask" }],
      };

    case "start": {
      if (task.status === "running" && task.hold === undefined) return { next: task, effects: [] };
      if (task.status === "review")
        return refuse(
          "wrong-status",
          "A task in review goes back to work with sendBack.",
          "Send it back with feedback.",
        );
      if (task.status === "mr")
        return refuse(
          "wrong-status",
          "A task with a merge request open does not start again.",
          "Close the merge request first, then send it back.",
        );
      if (task.status !== "inbox" && task.status !== "ready" && task.status !== "running")
        return wrongStatus(event.type, task);
      if (task.hold !== undefined) return heldRefusal(task.hold);
      if (task.unmetDeps.length > 0)
        return refuse(
          "unmet-dependencies",
          `It waits for ${task.unmetDeps.join(", ")}.`,
          "Start those first or remove the link.",
        );
      return {
        next: { ...task, status: "running", startWhenReady: false },
        effects: [
          { kind: "runs.start" },
          { kind: "ensureWorktrees" },
          { kind: "publishTask" },
          { kind: "statusChanged" },
        ],
      };
    }

    case "sendBack":
      if (task.status !== "review") return wrongStatus(event.type, task);
      if (task.hold !== undefined) return heldRefusal(task.hold);
      return {
        next: { ...task, status: "running" },
        effects: [{ kind: "runs.start" }, { kind: "publishTask" }],
      };

    case "ownerStop":
      if (!IN_FLIGHT.includes(task.status)) return wrongStatus(event.type, task);
      return place(task, { cause: "owner-stop", at: event.at }, () => stopEffects("you stopped the task"));

    case "captainStop":
      if (!IN_FLIGHT.includes(task.status)) return wrongStatus(event.type, task);
      return place(
        task,
        { cause: "captain-stop", at: event.at, ...(event.why === undefined ? {} : { why: event.why }) },
        () => stopEffects("the captain stopped the task"),
      );

    case "autopilotOff": {
      if (!IN_FLIGHT.includes(task.status)) return wrongStatus(event.type, task);
      const hold: Hold = { cause: "autopilot-off", at: event.at, mode: event.mode };
      return place(task, hold, (kept) =>
        kept.cause === "autopilot-off" && kept.mode === "step"
          ? [{ kind: "publishTask" }]
          : stopEffects("Auto-pilot was turned off"),
      );
    }

    case "autopilotOn": {
      const hold = task.hold;
      if (hold?.cause !== "autopilot-off") return { next: task, effects: [] };
      if (!event.resume && hold.mode === "now") {
        // "Leave paused": the owner now owns the pause, so only the owner can lift it.
        return {
          next: { ...task, hold: { cause: "owner-stop", at: event.at } },
          effects: [{ kind: "publishTask" }],
        };
      }
      return {
        next: { ...task, hold: undefined },
        effects: [
          ...(task.hasLiveRun ? [] : [{ kind: "runs.start" } as const]),
          { kind: "containers", op: "runAgain" },
          { kind: "card", card: "settle" },
          { kind: "publishTask" },
        ],
      };
    }

    case "runPaused":
      if (!IN_FLIGHT.includes(task.status)) return wrongStatus(event.type, task);
      return place(task, event.hold, pausedEffects);

    case "runResumed": {
      if (!IN_FLIGHT.includes(task.status)) return wrongStatus(event.type, task);
      if (task.hold === undefined) return { next: task, effects: [] };
      if (!liftersOf(task.hold).includes("majhi")) return refuse("not-allowed", sentenceOf(task.hold));
      return {
        next: { ...task, hold: undefined },
        effects: [
          { kind: "containers", op: "runAgain" },
          { kind: "ensureWorktrees" },
          ...(task.hasLiveRun ? [] : [{ kind: "runs.start" } as const]),
          { kind: "card", card: "settle" },
          { kind: "publishTask" },
        ],
      };
    }

    case "holdPlaced":
      if (task.status === "mr" || task.status === "done") return wrongStatus(event.type, task);
      return place(task, event.hold, pausedEffects);

    case "holdCleared": {
      const hold = task.hold;
      if (hold === undefined) return refuse("not-held", `${task.id} has no hold to lift.`);
      if (!liftersOf(hold).includes(event.by)) return refuse("not-allowed", sentenceOf(hold));
      if (event.by === "majhi" && !conditionMet(autoClears(hold), event.reading))
        return refuse("condition-not-met", sentenceOf(hold));
      const exempt = event.by === "owner" && hold.cause === "budget-limit";
      return {
        next: { ...task, hold: undefined, exemptUntilRunEnds: exempt ? true : task.exemptUntilRunEnds },
        effects: [
          ...(IN_FLIGHT.includes(task.status) && !task.hasLiveRun ? [{ kind: "runs.start" } as const] : []),
          ...(exempt ? [{ kind: "budgets.exempt" } as const] : []),
          { kind: "card", card: "settle" },
          { kind: "publishTask" },
        ],
      };
    }

    case "agentsIdle":
      if (task.status !== "running") return wrongStatus(event.type, task);
      if (task.hold !== undefined) return heldRefusal(task.hold);
      return {
        next: { ...task, status: "review" },
        effects: [{ kind: "card", card: "review" }, { kind: "publishTask" }],
      };

    case "processEnded":
      if (task.status !== "review") return wrongStatus(event.type, task);
      if (task.hold !== undefined) return heldRefusal(task.hold);
      return { next: { ...task, status: "running" }, effects: [{ kind: "publishTask" }] };

    case "changeAndReview":
      if (task.status !== "inbox") return wrongStatus(event.type, task);
      return { next: { ...task, status: "review" }, effects: [{ kind: "card", card: "review" }] };

    case "mrOpened":
      if (task.status === "mr" || task.status === "done") return wrongStatus(event.type, task);
      return { next: { ...task, status: "mr" }, effects: [{ kind: "card", card: "mr" }] };

    case "mrClosedUnmerged":
      if (task.status !== "mr") return wrongStatus(event.type, task);
      return { next: { ...task, status: "review" }, effects: [{ kind: "card", card: "review" }] };

    case "close":
      if (task.status === "done") return wrongStatus(event.type, task);
      return {
        next: { ...task, status: "done", hold: undefined, startWhenReady: false, exemptUntilRunEnds: false },
        effects: [
          { kind: "runs.stop" },
          { kind: "containers", op: "stop" },
          { kind: "processes.stop" },
          { kind: "card", card: "done" },
        ],
      };

    case "reopen":
      if (task.status !== "done") return wrongStatus(event.type, task);
      return { next: { ...task, status: event.to }, effects: [{ kind: "card", card: "review" }] };

    case "dependencyChanged": {
      const unmetAfter = (): string[] => task.unmetDeps.filter((d) => !event.on.includes(d));
      if (event.change === "met") {
        if (task.status !== "inbox" && task.status !== "ready") return wrongStatus(event.type, task);
        return { next: { ...task, unmetDeps: unmetAfter() }, effects: [] };
      }
      if (event.on.length === 0) return refuse("nothing-to-do", "No task is named.");
      const waiting = task.status === "inbox" || task.status === "ready";
      if (event.change === "closed-unmerged") {
        if (!waiting) return wrongStatus(event.type, task);
        const hold: Hold = {
          cause: "dependency-closed",
          at: event.at,
          on: [...event.on] as [string, ...string[]],
        };
        const kept = mergeHold(task.hold, hold);
        return {
          next: { ...task, hold: kept, startWhenReady: false },
          effects: [{ kind: "card", card: "paused" }, { kind: "publishTask" }],
        };
      }
      const hasDependencyHold =
        task.hold?.cause === "dependency-closed" || task.hold?.cause === "dependency-removed";
      if (!waiting && !(IN_FLIGHT.includes(task.status) && hasDependencyHold))
        return wrongStatus(event.type, task);
      const removed: Hold = {
        cause: "dependency-removed",
        at: event.at,
        on: [...event.on] as [string, ...string[]],
      };
      return {
        next: {
          ...task,
          hold: mergeHold(task.hold, removed),
          startWhenReady: false,
          unmetDeps: unmetAfter(),
        },
        effects: [{ kind: "card", card: "paused" }, { kind: "publishTask" }],
      };
    }

    case "runLost": {
      if (task.status !== "running") return wrongStatus(event.type, task);
      if (task.hold !== undefined || task.hasLiveRun)
        return refuse("nothing-to-do", `${task.id} already has a run or a reason.`);
      if (event.autoResume) return { next: task, effects: [{ kind: "runs.start" }] };
      const hold: Hold = {
        cause: "error",
        at: event.at,
        phase: "restart",
        error: "majhi restarted while it was running.",
      };
      return { next: { ...task, hold }, effects: pausedEffects(hold) };
    }
  }
}
