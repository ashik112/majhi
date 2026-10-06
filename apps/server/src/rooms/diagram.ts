import {
  type DiagramSpec,
  type JourneyView,
  journeySpec,
  mapSlice,
  type ProjectMap,
  type TaskId,
} from "@majhi/shared";
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
  input: { around?: string | undefined; depth: 1 | 2; journey?: string | undefined },
  journeys: readonly JourneyView[] = [],
): string {
  if (input.journey !== undefined) {
    const want = input.journey.toLowerCase();
    const found = journeys.find((j) => j.id === input.journey || j.name.toLowerCase() === want);
    if (found === undefined) {
      const names = journeys.map((j) => `"${j.name}"`).join(", ");
      throw new UserError(
        journeys.length === 0
          ? "This workspace has no journeys yet."
          : `There is no journey "${input.journey}". The journeys are: ${names}.`,
      );
    }
    const drawn = journeySpec(map, found);
    if ("problem" in drawn) throw new UserError(drawn.problem);
    return drawDiagram(room, caller, drawn.spec);
  }
  const slice = mapSlice(map, input);
  if ("problem" in slice) throw new UserError(slice.problem);
  return drawDiagram(room, caller, slice.spec);
}
