import type { OwnerDecision, OwnerDecisionKind } from "./inbox.ts";

/**
 * The Needs you queue of the console (docs/briefs/workflow-reset.md, step 3): the decisions the inbox
 * already lists, put in four groups and with repeats merged into one row. Everything here is decided
 * from typed fields (a decision's kind, its task's `waitingOn`), never from its words.
 */

/** The groups of Needs you, in the order they are shown. `captain` holds what the captain did by itself. */
export const QUEUE_GROUPS = ["incident", "decide", "review", "captain"] as const;
export type QueueGroup = (typeof QUEUE_GROUPS)[number];

export const QUEUE_GROUP_LABEL: Record<QueueGroup, string> = {
  incident: "Incidents",
  decide: "Decide",
  review: "Review",
  captain: "Done by the captain",
};

/** How many rows a group shows before "Show N more". The captain's done items are a glance, so fewer. */
export const QUEUE_GROUP_SHOWN: Record<QueueGroup, number> = {
  incident: 8,
  decide: 8,
  review: 8,
  captain: 3,
};

const GROUP_OF_KIND: Record<OwnerDecisionKind, Exclude<QueueGroup, "captain">> = {
  incident: "incident",
  ship: "review",
  publish: "review",
  draft: "review",
  batch: "review",
  question: "decide",
  approval: "decide",
  budget: "decide",
  paused: "decide",
  "sign-in": "decide",
  secret: "decide",
  reply: "decide",
  trust: "decide",
  notifications: "decide",
};

/** The group a decision is shown in. */
export function queueGroupOf(decision: Pick<OwnerDecision, "kind">): Exclude<QueueGroup, "captain"> {
  return GROUP_OF_KIND[decision.kind];
}

/**
 * What makes decisions the same row. Two decisions with the same key are one problem asked many times:
 * every sign-in is "an account is signed out"; tasks held by the same unmet dependencies wait on one
 * thing, so one answer fixes them all. A decision with no repeat has no key and stands alone.
 */
export type MergeKey = { kind: "signin" } | { kind: "blocker"; tasks: readonly string[] };

export function mergeKeyOf(
  decision: Pick<OwnerDecision, "kind" | "task">,
  waitingOn: (task: string) => readonly string[],
): MergeKey | undefined {
  if (decision.kind === "sign-in") return { kind: "signin" };
  if (decision.kind === "paused" && decision.task !== undefined) {
    const tasks = waitingOn(decision.task);
    if (tasks.length > 0) return { kind: "blocker", tasks: tasks.toSorted() };
  }
  return undefined;
}

function keyText(key: MergeKey): string {
  return key.kind === "signin" ? "signin" : `blocker:${key.tasks.join(",")}`;
}

/** The groups made of decisions; Done by the captain is made of notices. */
export type DecisionGroup = Exclude<QueueGroup, "captain">;

/** One line of the queue: one decision, or several that repeat. `decisions` is oldest first. */
export interface QueueRow {
  /** Stable while the row exists: the id of its decision, or the merge key of a merged row. */
  id: string;
  group: DecisionGroup;
  decisions: readonly OwnerDecision[];
  /** What the repeats have in common, when there are several. */
  key?: MergeKey;
  /** The oldest decision's time: how long the row has waited. */
  at: string;
}

/**
 * The queue: decisions grouped, repeats merged, each group oldest first. A group's rows are never
 * dropped; the screen decides how many to show.
 */
export function buildQueue(
  decisions: readonly OwnerDecision[],
  waitingOn: (task: string) => readonly string[],
): Record<DecisionGroup, QueueRow[]> {
  const rows: Record<DecisionGroup, QueueRow[]> = { incident: [], decide: [], review: [] };
  const open = new Map<string, { row: QueueRow; decisions: OwnerDecision[] }>();
  for (const decision of decisions.toSorted((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    const group = queueGroupOf(decision);
    const key = mergeKeyOf(decision, waitingOn);
    if (key === undefined) {
      rows[group].push({ id: decision.id, group, decisions: [decision], at: decision.at });
      continue;
    }
    const id = `${group}:${keyText(key)}`;
    const seen = open.get(id);
    if (seen === undefined) {
      const list = [decision];
      const row: QueueRow = { id, group, decisions: list, key, at: decision.at };
      open.set(id, { row, decisions: list });
      rows[group].push(row);
    } else {
      seen.decisions.push(decision);
    }
  }
  return rows;
}
