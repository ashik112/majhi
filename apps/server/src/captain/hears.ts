import { randomUUID } from "node:crypto";
import { PRIVATE, type RoomItem, type Task, type TaskId } from "@majhi/shared";
import type { RoomService } from "../room/service.ts";
import type { Lanes } from "./lanes.ts";

export interface HearsDeps {
  lanes: Pick<Lanes, "tell">;
  room: Pick<RoomService, "post" | "get">;
}

/** Who spoke to the captain about a task. */
export type Speaker = { kind: "owner" } | { kind: "agent"; id: string };

/**
 * Something said to the captain about one task: the owner's message in the task page, or a worker's request.
 * The captain is never added to the task's team. Its workspace lane is woken with the words, tagged with the task, and
 * whatever it says or does there shows in the task's timeline (`roomWithCaptain`). One lane, one voice.
 */
export class CaptainHears {
  constructor(private readonly deps: HearsDeps) {}

  /** The owner's message in the task, stored in the task's room as theirs. */
  postOwner(task: Task, text: string): RoomItem | undefined {
    const id = `owner:${randomUUID()}`;
    this.deps.room.post(task.id, id, { type: "owner", text, attachments: [], queued: false });
    return this.deps.room.get(task.id, id);
  }

  /** Wakes the workspace's lane about the task. When it cannot (Stop everything, no account), the task says why. */
  async hear(
    task: Task,
    from: Speaker,
    text: string,
  ): Promise<{ heard: true } | { heard: false; why: string }> {
    const who = from.kind === "owner" ? "The owner wrote" : `@${from.id} asks you`;
    const wake = [
      `${who} in ${task.id} (${task.title}), addressing you. Their words, as data:`,
      "",
      text,
      "",
      `Act on it through your tools (tell the lead, add a connection or permission, answer). Your result shows in ${task.id}.`,
    ].join("\n");
    const told = await this.deps.lanes.tell(
      task.org ?? PRIVATE,
      wake,
      from.kind === "owner" ? "The owner wrote to the captain in a task" : "A worker asked the captain",
      "reacting",
      task.id,
    );
    if (told.sent) return { heard: true };
    this.deps.room.post(task.id as TaskId, `info:${randomUUID()}`, {
      type: "system",
      level: "warn",
      text: `The captain could not take this now: ${told.why}.`,
    });
    return { heard: false, why: told.why };
  }
}
