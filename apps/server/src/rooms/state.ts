import { z } from "zod";

/**
 * What the room remembers between turns (5.3), stored on the task so a restart keeps it:
 * agent-to-agent turns since the owner last wrote (the loop guard), the pipeline's next step,
 * and the review loop's round.
 */
export const RoomStateSchema = z.object({
  /**
   * Handoffs between agents in a row that changed nothing in the worktrees (the loop guard).
   * The owner's message and any turn that changes files or commits reset it.
   */
  agentTurns: z.number().int().nonnegative().default(0),
  /** The worktrees' state after the last turn (HEADs and uncommitted changes), to see progress. */
  fingerprint: z.string().optional(),
  /** Pipeline: the index of the stage that runs now, in `pipelineStages` order. */
  stage: z.number().int().nonnegative().optional(),
  /** Pipeline: agents of the current stage that have not finished their turn yet. */
  pending: z.array(z.string()).optional(),
  /** Review loop: rounds the reviewer has sent back so far. */
  round: z.number().int().nonnegative().optional(),
  /** Agents the owner took off the team. An agent's mention does not bring them back; the owner can. */
  removed: z.array(z.string()).optional(),
});
export type RoomState = z.infer<typeof RoomStateSchema>;

export const EMPTY_ROOM_STATE: RoomState = { agentTurns: 0 };

export function parseRoomState(json: string): RoomState {
  try {
    const parsed = RoomStateSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : { ...EMPTY_ROOM_STATE };
  } catch {
    return { ...EMPTY_ROOM_STATE };
  }
}
