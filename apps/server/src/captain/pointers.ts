import { PRIVATE, type Task, type TaskId } from "@majhi/shared";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { Lanes } from "./lanes.ts";

export interface PointerDeps {
  store: Pick<Store, "room">;
  room: Pick<RoomService, "post">;
  lanes: Pick<Lanes, "chat">;
}

/**
 * Pointer lines in the workspace thread: one when a task the captain side opened or started begins, one when it finishes.
 * They link the task and copy nothing of it (the thread is not where that work lives).
 */
export class Pointers {
  constructor(private readonly deps: PointerDeps) {}

  private thread(task: Task): string | undefined {
    const org = task.org ?? PRIVATE;
    return this.deps.lanes.chat(org, "backlog") ?? this.deps.lanes.chat(org, "reacting");
  }

  private write(task: Task, key: "opened" | "done", text: string): void {
    if (task.kind === "chat") return;
    const thread = this.thread(task);
    if (thread === undefined) return;
    const id = `pointer:${key}:${task.id}`;
    if (this.deps.store.room.get(thread, id) !== undefined) return;
    this.deps.room.post(thread as TaskId, id, { type: "system", level: "info", text, pointer: task.id });
  }

  /** The captain side opened or started this task. Once per task. In `chat`, when the owner's root chat made it. */
  opened(task: Task, chat?: string): void {
    if (chat === undefined) {
      this.write(task, "opened", `Opened ${task.id}: ${task.title}`);
      return;
    }
    this.deps.room.post(chat as TaskId, `pointer:made:${task.id}`, {
      type: "system",
      level: "info",
      text: `Opened ${task.id}: ${task.title}`,
      pointer: task.id,
    });
  }

  /** The task finished. Only a task that has an "opened" line gets one. */
  done(task: Task): void {
    const thread = this.thread(task);
    if (thread === undefined || this.deps.store.room.get(thread, `pointer:opened:${task.id}`) === undefined)
      return;
    const resolved = task.typing?.type === "incident" || task.typing?.type === "bug";
    this.write(task, "done", resolved ? `Resolved ${task.id}` : `Finished ${task.id}: ${task.title}`);
  }
}
