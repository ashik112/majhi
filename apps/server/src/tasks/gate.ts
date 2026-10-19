/**
 * The one gate every task creator and every start goes through (workflow reset, Step 1). Pure: the
 * caller reads the counts and the limits and acts on the answer.
 *
 *  - The owner's own tasks are never ideas. They start, or wait in line when `tasks_running` tasks run.
 *  - A task an agent or a finding makes is always an idea: it exists, shows under Ideas, and starts only
 *    when the owner starts it.
 *  - The captain, incidents, client chats and schedules are capped: past `open_by_others` open tasks the
 *    owner did not start, in one workspace, a new one is an idea; under it they start or wait like the
 *    owner's.
 *  - Chat tasks (one agent, a conversation, the captain's lanes) are not tasks of this gate at all.
 */

/** Who is making the task. */
export type Origin = "owner" | "captain" | "agent" | "incident" | "client-chat" | "schedule" | "finding";

export interface GateLimits {
  /** `limits.tasks_running`: tasks running at once across every workspace. */
  tasks_running: number;
  /** `limits.open_by_others`: open tasks per workspace that the owner did not make. */
  open_by_others: number;
}

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
  origin: Origin;
  /** The workspace the task is in: the key of `counts.openByOthers`. */
  org: string;
  wantsStart: boolean;
  counts: GateCounts;
  limits: GateLimits;
}): Admission {
  const { origin, org, wantsStart, counts, limits } = input;
  if (origin === "agent" || origin === "finding") return { kind: "idea", reason: "agent-made" };
  if (origin !== "owner" && (counts.openByOthers[org] ?? 0) >= limits.open_by_others) {
    return { kind: "idea", reason: "open-cap" };
  }
  return wantsStart ? admitRunning(counts, limits) : { kind: "file" };
}
