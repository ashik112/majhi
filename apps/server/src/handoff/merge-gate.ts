import type {
  HandoffResult,
  HandoffState,
  HandoffStepId,
  MergeChecks,
  MergeVerdict,
  Task,
} from "@majhi/shared";
import { scanRepoDiff } from "./ready.ts";
import { taskHeads } from "./wire.ts";

/**
 * The merge rule, in one place: nothing merges into a target unless the hand-off checks are green
 * for the exact commit being merged. `TaskService.merge` is the only function that merges a task's
 * branch, so every path (owner, captain, decision answers, the ship chore, push after merge, an
 * agent tool, a ship that waited for its lead) reaches this through it. No text is matched: the
 * answer is a typed verdict.
 */

export interface MergeFacts {
  /** The project cards of the task's repos set at least one of test, build or lint. */
  configured: boolean;
  /** The task's head commits now (`project@sha` per repo): the exact state being merged. */
  head: string;
  /** What the hand-off knows of this task: the result for `head`, or the last result for an older one. */
  state: Pick<HandoffState, "current" | "running" | "queued"> | undefined;
}

const KINDS = [
  ["tests", "test"],
  ["build", "build"],
  ["lint", "lint"],
] as const satisfies readonly (readonly [HandoffStepId, "test" | "build" | "lint"])[];

const FAILED = new Set(["fail", "timeout", "flaky"]);

/** The verdict of the recorded checks for `head`. The secret scan is not in here: it is checked on the diff itself. */
export function decideMerge(facts: MergeFacts): MergeVerdict {
  if (!facts.configured) return { kind: "ok", noChecks: true };
  const current: HandoffResult | undefined = facts.state?.current;
  const atHead = current !== undefined && current.head === facts.head;
  // A check of this very commit that is running or waiting says nothing yet.
  if (!atHead && (facts.state?.running === true || facts.state?.queued === true)) return { kind: "running" };
  if (current === undefined) return { kind: "stale", ran: false };
  if (!atHead) return { kind: "stale", ran: true };
  // The cheap checks failed first (a conflict, uncommitted work, a waiting card): running again changes nothing.
  const ready = current.steps.find((s) => s.id === "ready");
  if (ready?.status === "fail")
    return {
      kind: "blocked",
      why: ready.detail ?? "the first checks failed",
      ...(ready.owner === true ? { owner: true as const } : {}),
    };
  for (const [id, check] of KINDS) {
    const step = current.steps.find((s) => s.id === id);
    if (step !== undefined && FAILED.has(step.status)) return { kind: "failed", check };
  }
  // A step that was not run (the cheap checks failed first, or the tests waited for a build) is no evidence.
  for (const [id] of KINDS) {
    const step = current.steps.find((s) => s.id === id);
    if (step === undefined || step.status === "skipped") return { kind: "stale", ran: false };
  }
  if (facts.state?.running === true || facts.state?.queued === true) return { kind: "running" };
  return { kind: "ok" };
}

export interface MergeGateDeps {
  /** The hand-off service. Absent until the server finishes starting: nothing merges then. */
  handoff(): { state(id: string): Promise<HandoffState> } | undefined;
  /** Whether the project card sets a test, build or lint command. */
  configured(project: string): boolean;
}

type Repo = Task["repos"][number];

export class MergeGate {
  constructor(private readonly deps: MergeGateDeps) {}

  /**
   * The verdict for the task's branch tips now, for a merge of `repos`. The secret scan of the diff
   * comes first and is final.
   */
  async checks(task: Task, repos: readonly Repo[]): Promise<MergeChecks> {
    const head = await taskHeads(task);
    for (const repo of repos) {
      const scan = await scanRepoDiff(repo);
      if (scan?.kind === "secret") return { head, verdict: { kind: "failed", check: "secret" } };
    }
    const handoff = this.deps.handoff();
    const configured = task.repos.some((r) => this.deps.configured(r.project));
    const state = handoff === undefined ? undefined : await handoff.state(task.id).catch(() => undefined);
    return { head, verdict: decideMerge({ configured, head, state }) };
  }
}
