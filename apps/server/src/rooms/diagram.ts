import { type DiagramSpec, mapSlice, type ProjectMap, type TaskId } from "@majhi/shared";
import { UserError } from "../errors.ts";
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

/**
 * `show_map`: a slice of the stored map of the caller's own workspace (`org` is the caller's task's
 * workspace, never an argument), drawn the same way. Throws a plain reason when there is nothing to draw.
 */
export function drawMap(
  room: RoomService,
  caller: ToolCaller,
  _org: string,
  map: ProjectMap,
  input: { around?: string | undefined; depth: 1 | 2 },
): string {
  const slice = mapSlice(map, input);
  if ("problem" in slice) throw new UserError(slice.problem);
  return drawDiagram(room, caller, slice.spec);
}
