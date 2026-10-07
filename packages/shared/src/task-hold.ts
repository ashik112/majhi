import { z } from "zod";

/**
 * A task's hold as the board reads it. The hold itself lives in the lifecycle model
 * (`lifecycle/hold.ts`); this is its read model, built on the server from the model's own tables, so
 * the web asks no question of the stored pause fields.
 *
 * `lifter` is who ends it: `owner` when only the owner (or the captain) can, `system` when majhi
 * ends it on a condition it watches (a budget with room again, an account that signed in). A hold
 * that ends when somebody speaks in the task is the owner's in practice, so it counts as `owner`.
 */
export const HoldLifterSchema = z.enum(["owner", "system"]);
export type HoldLifter = z.infer<typeof HoldLifterSchema>;

export const HoldViewSchema = z.object({
  lifter: HoldLifterSchema,
  /** The cause in a few words, for a line that starts "Held:". */
  label: z.string().min(1),
  /** The one sentence of the model that says what it is and what lifts it. */
  sentence: z.string().min(1),
});
export type HoldView = z.infer<typeof HoldViewSchema>;
