import type { HandoffStepId } from "./handoff.ts";
import { liftersOf } from "./lifecycle/hold.ts";
import { fromStored } from "./lifecycle/stored.ts";
import type { CiState, MrState } from "./mr-state.ts";
import type { Trail, TrailStep, TrailTone } from "./task-trail.ts";
import type { PausedBy, PausedReason, TaskStatus } from "./tasks.ts";

/**
 * Assembles a task's trail from facts the server already holds. Pure: it decides each step's tone
 * and nothing else, so the board and the task page read the same trail.
 */

export interface StatusFacts {
  status: TaskStatus;
  pausedReason?: PausedReason | undefined;
  pausedBy?: PausedBy | undefined;
}

/**
 * How a task's own state reads: running is working, done is done, review and a merge request wait
 * for the owner, a paused task needs the owner when only an owner (or the captain) can lift its hold
 * and is paused when majhi lifts it by itself, and a task that has not started is idle.
 */
export function statusTone(task: StatusFacts): TrailTone {
  switch (task.status) {
    case "done":
      return "done";
    case "running":
      return "working";
    case "review":
    case "mr":
      return "needs";
    case "inbox":
    case "ready":
      return "idle";
    case "paused": {
      const { hold } = fromStored(
        { status: "paused", pausedReason: task.pausedReason, pausedBy: task.pausedBy },
        { at: "" },
      );
      return hold !== undefined && liftersOf(hold).includes("majhi") ? "paused" : "needs";
    }
  }
}

/** Needs the owner before anything, then moving, then held, then idle. */
const URGENCY: readonly TrailTone[] = ["needs", "working", "paused", "idle", "done"];

/** The tone of a group: the most urgent of its members, or `done` when every one is. */
export function worstTone(tones: readonly TrailTone[]): TrailTone {
  return URGENCY.find((t) => tones.includes(t)) ?? "idle";
}

export interface ChildFact extends StatusFacts {
  id: string;
  /** Set for the single read, which lists the children. */
  title?: string | undefined;
}

export interface MrFact {
  project: string;
  number: number;
  url: string;
  state: MrState;
  ci: CiState;
}

export interface TrailFacts {
  children: readonly ChildFact[];
  /** One entry per repo that has a merge request. */
  mrs: readonly MrFact[];
  /** Projects whose branch majhi merged locally. */
  merged: readonly string[];
  /** A ship waits for the lead to resolve conflicts: the projects it covers. */
  pendingShip: readonly string[];
  /** The hand-off check of the task's head now, when it has one. */
  check?: { result: "green" | "red" | "running" | "queued"; failedStep?: HandoffStepId | undefined };
}

function mrTone(mr: MrFact): TrailTone {
  if (mr.state === "merged") return "done";
  if (mr.state === "open" && mr.ci === "pending") return "working";
  return "needs";
}

const CHECK_TONE = { green: "done", red: "needs", running: "working", queued: "working" } as const;

export function buildTrail(facts: TrailFacts): Trail {
  const steps: TrailStep[] = [];
  if (facts.children.length > 0) {
    const tones = facts.children.map(statusTone);
    const withItems = facts.children.every((c) => c.title !== undefined);
    steps.push({
      kind: "children",
      tone: worstTone(tones),
      total: facts.children.length,
      done: facts.children.filter((c) => c.status === "done").length,
      ...(withItems
        ? {
            items: facts.children.map((c, i) => ({
              id: c.id,
              title: c.title ?? c.id,
              tone: tones[i] ?? "idle",
            })),
          }
        : {}),
    });
  }
  if (facts.check !== undefined) {
    steps.push({
      kind: "check",
      tone: CHECK_TONE[facts.check.result],
      result: facts.check.result,
      ...(facts.check.failedStep === undefined ? {} : { failedStep: facts.check.failedStep }),
    });
  }
  const [firstMr, ...otherMrs] = facts.mrs;
  if (firstMr !== undefined) {
    steps.push({
      kind: "merge-request",
      tone: worstTone(facts.mrs.map(mrTone)),
      mrs: [firstMr, ...otherMrs],
    });
  }
  const [firstPending, ...otherPending] = facts.pendingShip;
  const [firstMerged, ...otherMerged] = facts.merged;
  if (firstPending !== undefined) {
    steps.push({
      kind: "local-merge",
      tone: "working",
      stage: "pending",
      projects: [firstPending, ...otherPending],
    });
  } else if (firstMerged !== undefined) {
    steps.push({
      kind: "local-merge",
      tone: "done",
      stage: "merged",
      projects: [firstMerged, ...otherMerged],
    });
  }
  return steps;
}
