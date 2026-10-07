import { type DeployStepView, deployTone } from "./deploy.ts";
import type { HandoffStepId } from "./handoff.ts";
import type { CiState, MrState } from "./mr-state.ts";
import type { Trail, TrailStep, TrailTone } from "./task-trail.ts";
import type { TaskStatus } from "./tasks.ts";

/**
 * Assembles a task's trail from facts the server already holds. Pure: it decides each step's tone
 * and nothing else, so the board and the task page read the same trail.
 */

/**
 * How a task's own state reads in a trail: running is working, done is done, review and a merge
 * request wait for the owner, a paused task is paused (why it is paused is on its own card), and a
 * task that has not started is idle.
 */
export function statusTone(status: TaskStatus): TrailTone {
  switch (status) {
    case "done":
      return "done";
    case "running":
      return "working";
    case "review":
    case "mr":
      return "needs";
    case "paused":
      return "paused";
    case "inbox":
    case "ready":
      return "idle";
  }
}

/** Needs the owner before anything, then moving, then held, then idle. */
const URGENCY: readonly TrailTone[] = ["needs", "working", "paused", "idle", "done"];

/** The tone of a group: the most urgent of its members, or `done` when every one is. */
export function worstTone(tones: readonly TrailTone[]): TrailTone {
  return URGENCY.find((t) => tones.includes(t)) ?? "idle";
}

export interface ChildFact {
  id: string;
  status: TaskStatus;
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
  /** The step of shipping the rules leave to the owner now, when the task waits for them. */
  owner?: "merge" | "push" | undefined;
  /** The captain's merge waits for the task's deploy plan. */
  planWait?: boolean | undefined;
  /** One entry per target of the projects the task changed that has a deploy record or a pending decision. */
  deploys?: readonly DeployStepView[];
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
    const tones = facts.children.map((c) => statusTone(c.status));
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
  if (facts.owner !== undefined) steps.push({ kind: "ship", tone: "needs", step: facts.owner });
  else if (facts.planWait === true)
    steps.push({ kind: "ship", tone: "working", step: "merge", waits: "deploy-plan" });
  for (const d of facts.deploys ?? []) steps.push(deployTrailStep(d));
  return steps;
}

/** One deploy step as the trail draws it. */
export function deployTrailStep(d: DeployStepView): Extract<TrailStep, { kind: "deploy" }> {
  return {
    kind: "deploy",
    tone: deployTone(d.state),
    env: d.env,
    project: d.project,
    state: d.state,
    ...(d.commit === undefined ? {} : { commit: d.commit }),
    ...(d.run === undefined ? {} : { run: d.run }),
    ...(d.why === undefined ? {} : { why: d.why }),
    ...(d.incident === undefined ? {} : { incident: d.incident }),
  };
}
