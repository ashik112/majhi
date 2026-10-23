import { randomUUID } from "node:crypto";
import type { RoomItem, TaskId } from "@majhi/shared";
import type { RoomService } from "../room/service.ts";
import type { RoomPayload, Store } from "../store/index.ts";

/**
 * Cards that wait for nobody. A card waits for the owner only while what it is about still exists and still
 * needs it: a task that is done or removed has nothing left to ask, and a permission whose prompt went with its
 * run cannot be answered. Such a card is closed in the room with one line, so Needs you, the bell and the counts
 * never show it. One rule for every kind of card: the approval, the permission and the three kinds of question.
 */

/** Commands that act on a task that is done on purpose: an approval for them is not stale. */
const ON_FINISHED_TASKS: ReadonlySet<string> = new Set(["tasks.reopen", "tasks.remove", "tasks.close"]);

export interface StaleFacts {
  /** A task's status, or undefined when it does not exist. */
  status: (task: string) => string | undefined;
  /** Whether a permission card's prompt is still open in a run. Absent: the prompt is not looked at. */
  promptOpen?: ((item: Extract<RoomItem, { type: "permission" }>) => boolean) | undefined;
}

/** The task an approval's command acts on, from its stored input, or undefined when it names none. */
function targetOf(command: string, input: string): string | undefined {
  if (!command.startsWith("tasks.") || command === "tasks.create") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { id, task } = parsed as { id?: unknown; task?: unknown };
  const found = typeof id === "string" ? id : task;
  return typeof found === "string" && found !== "" ? found : undefined;
}

/** Why a pending card waits for nobody, in a short line, or undefined when it still waits. */
export function staleReason(item: RoomItem, facts: StaleFacts): string | undefined {
  switch (item.type) {
    case "approval":
    case "permission":
    case "ask":
    case "choice":
    case "owner-question":
      break;
    default:
      return undefined;
  }
  if (item.state !== "pending") return undefined;
  const own = facts.status(item.task);
  if (own === "done") return `${item.task} is done, so this has nothing left to decide.`;
  if (item.type === "approval" && item.proposal === undefined) {
    const target = targetOf(item.command, item.input);
    if (target !== undefined) {
      const status = facts.status(target);
      if (status === undefined) return `${target} was removed, so this has nothing left to decide.`;
      if (status === "done" && !ON_FINISHED_TASKS.has(item.command)) {
        return `${target} is done, so this has nothing left to decide.`;
      }
    }
  }
  if (item.type === "permission" && facts.promptOpen?.(item) === false) {
    return "The agent is no longer waiting for this answer.";
  }
  return undefined;
}

/** The card as it is stored once closed. Undefined for an item that is not one of these cards. */
function closed(item: RoomItem, why: string): RoomPayload | undefined {
  switch (item.type) {
    case "approval": {
      const { id: _id, task: _task, seq: _seq, at: _at, ...rest } = item;
      return { ...rest, state: "rejected", result: why };
    }
    case "permission": {
      const { id: _id, task: _task, seq: _seq, at: _at, ...rest } = item;
      return { ...rest, state: "cancelled" };
    }
    case "ask": {
      const { id: _id, task: _task, seq: _seq, at: _at, ...rest } = item;
      return { ...rest, state: "cancelled" };
    }
    case "choice": {
      const { id: _id, task: _task, seq: _seq, at: _at, ...rest } = item;
      return { ...rest, state: "cancelled" };
    }
    case "owner-question": {
      const { id: _id, task: _task, seq: _seq, at: _at, ...rest } = item;
      return { ...rest, state: "moved-on" };
    }
    default:
      return undefined;
  }
}

export interface StaleCardsDeps {
  store: Pick<Store, "room" | "tasks">;
  room: Pick<RoomService, "post">;
  /** The prompt of a permission card is still open in a run. */
  promptOpen?: StaleFacts["promptOpen"];
  /** Something was closed: screens and counts read again. */
  changed?: (() => void) | undefined;
}

/** Closes the cards that wait for nobody. Safe to run any time and as often as wanted. */
export class StaleCards {
  constructor(private readonly deps: StaleCardsDeps) {}

  /** Closes every pending card whose task is done or removed or whose prompt is gone. Returns how many closed. */
  sweep(): number {
    const { store, room } = this.deps;
    const facts: StaleFacts = {
      status: (id) => store.tasks.subjectInfo(id)?.status,
      promptOpen: this.deps.promptOpen,
    };
    let count = 0;
    for (const item of store.room.waitingDecisions()) {
      const why = staleReason(item, facts);
      if (why === undefined) continue;
      const payload = closed(item, why);
      if (payload === undefined) continue;
      try {
        room.post(item.task as TaskId, item.id, payload);
        // The room line is only for a room that still exists.
        if (facts.status(item.task) !== undefined) {
          room.post(item.task as TaskId, `stale:${randomUUID()}`, {
            type: "system",
            level: "info",
            text: `Closed a request that waited for nobody: ${why}`,
          });
        }
        count += 1;
      } catch {
        // A card whose task went away mid-way: it goes with its task.
      }
    }
    if (count > 0) this.deps.changed?.();
    return count;
  }
}
