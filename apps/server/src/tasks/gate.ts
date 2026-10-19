/**
 * The one gate every task creator and every start goes through (workflow reset, Step 1). Pure: the
 * caller reads the counts and the limits and acts on the answer.
 *
 *  - The owner's own tasks are never ideas. They start, or wait in line when `tasks_running` tasks run.
 *  - A task an agent or a finding makes is always an idea: it exists, shows under Ideas, and starts only
 *    when the owner starts it.
 *  - The captain, client chats and schedules are capped: past `open_by_others` open tasks the owner did
 *    not start, in one workspace, a new one is an idea; under it they start or wait like the owner's.
 *  - An incident is never an idea (an outage must not wait in Ideas); it only waits for a running place.
 *  - Chat tasks (one agent, a conversation, the captain's lanes) are not tasks of this gate at all.
 */

import type { GateOrigin, LimitsSettings } from "@majhi/shared";

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
  | { kind: "idea"; reason: "open-cap" | "agent-made" };

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
}): Admission {
  const { origin, org, wantsStart, counts, limits } = input;
  if (origin === "agent" || origin === "finding") return { kind: "idea", reason: "agent-made" };
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
