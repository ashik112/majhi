import { z } from "zod";

/** What an agent does in a task team. */
export const RoleSchema = z.enum(["Lead", "Builder", "Reviewer", "Tester", "Root"]);
export type Role = z.infer<typeof RoleSchema>;

/** Fallback for a model pick, by price rank among the models on offer. */
export const ModelTierSchema = z.enum(["most-capable", "balanced", "cheapest"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/** Fallback for an effort pick, by position in the list the CLI offers (lowest first). */
export const EffortTierSchema = z.enum(["highest", "middle", "lowest"]);
export type EffortTier = z.infer<typeof EffortTierSchema>;

/** What a role falls back to when there is no confident pick. Either part may be left out. */
export const TierPatchSchema = z.strictObject({
  model: ModelTierSchema.optional(),
  effort: EffortTierSchema.optional(),
});
export type TierPatch = z.infer<typeof TierPatchSchema>;

/** Tiers by role, as an org or `decisions:` may set them: only the roles and parts that differ. */
export const TiersPatchSchema = z.strictObject(
  Object.fromEntries(RoleSchema.options.map((role) => [role, TierPatchSchema.optional()])) as Record<
    Role,
    z.ZodOptional<typeof TierPatchSchema>
  >,
);
export type TiersPatch = z.infer<typeof TiersPatchSchema>;

export type Tier = { model: ModelTier; effort: EffortTier };
export type Tiers = Record<Role, Tier>;

/** Leads plan and review, so they get the most; testers run checks, so they get the least. */
export const DEFAULT_TIERS: Readonly<Tiers> = {
  Lead: { model: "most-capable", effort: "highest" },
  Reviewer: { model: "most-capable", effort: "middle" },
  Builder: { model: "balanced", effort: "middle" },
  Tester: { model: "cheapest", effort: "lowest" },
  Root: { model: "balanced", effort: "middle" },
};

/** The tier for a role: the first layer that sets each part wins (agent, then org, then majhi, then the defaults). */
export function resolveTier(role: Role, ...layers: (TierPatch | undefined)[]): Tier {
  const base = DEFAULT_TIERS[role];
  return {
    model: layers.find((l) => l?.model !== undefined)?.model ?? base.model,
    effort: layers.find((l) => l?.effort !== undefined)?.effort ?? base.effort,
  };
}

export const MODEL_TIER_LABEL: Record<ModelTier, string> = {
  "most-capable": "Most capable",
  balanced: "Balanced",
  cheapest: "Cheapest",
};

export const EFFORT_TIER_LABEL: Record<EffortTier, string> = {
  highest: "Highest",
  middle: "Middle",
  lowest: "Lowest",
};
