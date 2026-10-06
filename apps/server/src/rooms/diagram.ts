import type { DiagramSpec, TaskId } from "@majhi/shared";
import type { RoomService } from "../room/service.ts";
import type { ToolCaller } from "./access.ts";

/** What an agent's diagram tools do: post one typed room item. The spec was checked by the tool's schema. */

export function drawDiagram(room: RoomService, caller: ToolCaller, spec: DiagramSpec): string {
  room.post(caller.task as TaskId, `diagram:${crypto.randomUUID()}`, {
    type: "diagram",
    agent: caller.agent,
    spec,
  });
  return `Drawn in the chat: ${spec.title}.`;
}
