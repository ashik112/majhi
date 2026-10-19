import { z } from "zod";

/**
 * What the room remembers between turns (5.3), stored on the task so a restart keeps it. Only the agents
 * the owner took off the team now: the loop guard's counters, the pipeline's stage and the review loop's
 * round went with those modes. Stored rows that still hold them read fine: the extra keys are dropped.
 */
export const RoomStateSchema = z.object({
  /** Agents the owner took off the team. Naming one in a plan step does not bring it back; the owner can. */
  removed: z.array(z.string()).optional(),
});
export type RoomState = z.infer<typeof RoomStateSchema>;

export const EMPTY_ROOM_STATE: RoomState = {};

export function parseRoomState(json: string): RoomState {
  try {
    const parsed = RoomStateSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : { ...EMPTY_ROOM_STATE };
  } catch {
    return { ...EMPTY_ROOM_STATE };
  }
}
