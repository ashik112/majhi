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

/**
 * What the owner does to end a hold, as data: the screens draw the button from it and never from the
 * hold's words. `resume` is the lift itself; `wait` means nothing to do, majhi lifts it.
 */
export const HoldFixSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove-links"), tasks: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("sign-in"), account: z.string().min(1) }),
  z.object({ kind: z.literal("open-account"), account: z.string().min(1) }),
  z.object({ kind: z.literal("raise-budget"), scope: z.string().min(1), scopeId: z.string().optional() }),
  z.object({ kind: z.literal("resume") }),
  z.object({ kind: z.literal("wait") }),
]);
export type HoldFix = z.infer<typeof HoldFixSchema>;

export const HoldViewSchema = z.object({
  lifter: HoldLifterSchema,
  /** The cause in a few words, for a line that starts "Held:". */
  label: z.string().min(1),
  /** The one sentence of the model that says what it is and what lifts it. */
  sentence: z.string().min(1),
  /** The one step that ends it. */
  fix: HoldFixSchema,
});
export type HoldView = z.infer<typeof HoldViewSchema>;
