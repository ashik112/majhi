/**
 * The one gate every task creator and every start goes through (workflow reset, Step 1). Pure: the
 * caller reads the counts and the limits and acts on the answer.
 *
 *  - The owner's own tasks are never ideas. They start, or wait in line when `tasks_running` tasks run.
 *  - A task the captain files on its own (the owner did not ask) is an idea too, and so is one an agent or a finding makes. It is always an idea: it exists, shows under Ideas, and starts only
 *    when the owner starts it.
 *  - The captain, client chats and schedules are capped: past `open_by_others` open tasks the owner did
 *    not start, in one workspace, a new one is an idea; under it they start or wait like the owner's.
 *  - An incident is never an idea (an outage must not wait in Ideas); it only waits for a running place.
 *  - Chat tasks (one agent, a conversation, the captain's lanes) are not tasks of this gate at all.
 */

import { type GateOrigin, type LimitsSettings, priorityRank, type TaskPriority } from "@majhi/shared";

/** The caps live in majhi.yaml `limits`; their defaults are in the schema, nowhere else. */
export type GateLimits = Pick<LimitsSettings, "tasks_running" | "open_by_others">;

export interface GateCounts {
  /** Tasks running now, chats left out, tasks that are starting included. */
  running: number;
  /** Open tasks the owner did not make, per workspace, ideas and chats left out. */
  openByOthers: Readonly<Record<string, number>>;
  /** The project's environment is held by another task (Step 2). Absent: free. */
  projectBusy?: boolean | undefined;
}

export type Admission =
  | { kind: "start" }
  /** Created and kept in the backlog: nobody asked it to start. */
  | { kind: "file" }
  | { kind: "queue"; reason: "running-cap" | "project-busy" }
  | { kind: "idea"; reason: "open-cap" | "agent-made" | "captain-made" };

/** Whether a start has room: `start`, or the line it waits in. */
export function admitRunning(
  counts: Pick<GateCounts, "running" | "projectBusy">,
  limits: Pick<GateLimits, "tasks_running">,
): Extract<Admission, { kind: "start" | "queue" }> {
  if (counts.running >= limits.tasks_running) return { kind: "queue", reason: "running-cap" };
  if (counts.projectBusy === true) return { kind: "queue", reason: "project-busy" };
  return { kind: "start" };
}

export function admit(input: {
  origin: GateOrigin;
  /** The workspace the task is in: the key of `counts.openByOthers`. */
  org: string;
  wantsStart: boolean;
  counts: GateCounts;
  limits: GateLimits;
  /** For the captain's origin: whether the owner asked for this task. `false`: it is the captain's own idea. */
  ownerAsked?: boolean | undefined;
}): Admission {
  const { origin, org, wantsStart, counts, limits } = input;
  if (origin === "agent" || origin === "finding") return { kind: "idea", reason: "agent-made" };
  // Autonomous never works on its own ideas: what the captain files without the owner asking waits for the owner.
  if (origin === "captain" && input.ownerAsked === false) return { kind: "idea", reason: "captain-made" };
  // An incident is reacting work: it is never an idea. It still waits for a running place, urgent first.
  if (
    origin !== "owner" &&
    origin !== "incident" &&
    (counts.openByOthers[org] ?? 0) >= limits.open_by_others
  ) {
    return { kind: "idea", reason: "open-cap" };
  }
  return wantsStart ? admitRunning(counts, limits) : { kind: "file" };
}

/** A task that runs now, as the preemption looks at it. */
export interface RunningPick {
  id: string;
  priority?: TaskPriority | undefined;
  /** The owner made it (or it is older than origins): the captain leaves it alone unless the owner asked. */
  ownedByOwner: boolean;
}

/**
 * Which running task pauses so an urgent one can run (workflow reset, step 1b). Only an urgent start
 * preempts, only a task of a lower priority, and the lowest priority first (the newest of those, which
 * has the least work to lose: `running` comes newest first). The owner may pause any; the captain only a
 * task it or an agent made, unless the owner asked in the conversation. Undefined when nobody qualifies:
 * the start waits in line as before.
 */
export function preemptionVictim(input: {
  wanted: TaskPriority | undefined;
  by: "owner" | "captain";
  ownerAsked: boolean;
  running: readonly RunningPick[];
}): string | undefined {
  if (input.wanted !== "urgent") return undefined;
  const may = (t: RunningPick) =>
    priorityRank(t.priority) > priorityRank(input.wanted) &&
    (input.by === "owner" || input.ownerAsked || !t.ownedByOwner);
  return [...input.running]
    .filter(may)
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority))
    .at(0)?.id;
}
