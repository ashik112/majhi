import { z } from "zod";

/**
 * Runtime settings in majhi.yaml that the owner or the boss can change live
 * (SPEC 5.7, 5.13, 5.16, 5.17). Every field has a default, so an empty
 * section means "use the defaults".
 */

/** Context budget (5.13). Orgs and agents can override `compact_at`. */
const contextFields = {
  /** Compact when used / size reaches this. */
  compact_at: z.number().gt(0).lt(1),
  /** Native compaction must bring usage under this, else majhi hands off to a fresh session. */
  compact_target: z.number().gt(0).lt(1),
  /** Replace the session with a fresh one after this many turns. 0 turns it off. */
  max_turns: z.number().int().min(0),
};
export const ContextSettingsSchema = z.strictObject({
  compact_at: contextFields.compact_at.default(0.8),
  compact_target: contextFields.compact_target.default(0.4),
  max_turns: contextFields.max_turns.default(40),
});
export type ContextSettings = z.infer<typeof ContextSettingsSchema>;
/**
 * Only the fields that are set. Zod 4 fills defaults inside `.partial()`, so a patch or a
 * majhi.yaml section is its own schema without defaults: an absent field stays absent.
 */
export const ContextPatchSchema = z.strictObject(contextFields).partial();

/** A duration like `10m`, `90s`, `2h`. */
export const DurationSchema = z
  .string()
  .regex(/^[1-9][0-9]*(s|m|h)$/, "Use a number and s, m or h, like 10m");

export function durationMs(value: string): number {
  const n = Number(value.slice(0, -1));
  const unit = value.at(-1);
  return n * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
}

/** Concurrency and idle limits (5.17). */
const limitsFields = {
  /** Agent processes running at once, across majhi. */
  agents_max: z.number().int().min(1).max(64),
  /** Agent processes running at once on one account. */
  per_account: z.number().int().min(1).max(16),
  /** Agent processes running at once in one task. */
  per_task: z.number().int().min(1).max(16),
  /** Stop an idle agent process after this long; it resumes on the next message. */
  idle_timeout: DurationSchema,
};
export const LimitsSettingsSchema = z.strictObject({
  agents_max: limitsFields.agents_max.default(6),
  per_account: limitsFields.per_account.default(2),
  per_task: limitsFields.per_task.default(3),
  idle_timeout: limitsFields.idle_timeout.default("10m"),
});
export type LimitsSettings = z.infer<typeof LimitsSettingsSchema>;
export const LimitsPatchSchema = z.strictObject(limitsFields).partial();

/** Resume after sleep, restarts, lost internet and crashes (5.7). */
export const ResumeSettingsSchema = z.strictObject({
  /** Resume interrupted runs on their own. Orgs can turn it off. */
  auto: z.boolean().default(true),
});
export type ResumeSettings = z.infer<typeof ResumeSettingsSchema>;
export const ResumePatchSchema = z.strictObject({ auto: z.boolean() }).partial();

/** How the boss's commands are approved, per risk class (5.16). */
export const ApprovalModeSchema = z.enum([
  /** Runs without asking. */
  "auto",
  /** Runs when the owner asked for it in the conversation; otherwise waits for a click. */
  "when-asked",
  /** Always waits for the owner's click. */
  "confirm",
]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const PolicySettingsSchema = z.strictObject({
  read: ApprovalModeSchema.default("auto"),
  change: ApprovalModeSchema.default("when-asked"),
  destructive: ApprovalModeSchema.default("confirm"),
  outbound: ApprovalModeSchema.default("confirm"),
  /** Per-command overrides, by command name. */
  commands: z.record(z.string(), ApprovalModeSchema).default({}),
});
export type PolicySettings = z.infer<typeof PolicySettingsSchema>;
/** `commands`, when given, replaces the whole map of per-command overrides. */
export const PolicyPatchSchema = z
  .strictObject({
    read: ApprovalModeSchema,
    change: ApprovalModeSchema,
    destructive: ApprovalModeSchema,
    outbound: ApprovalModeSchema,
    commands: z.record(z.string(), ApprovalModeSchema),
  })
  .partial();
export type PolicyPatch = z.infer<typeof PolicyPatchSchema>;

/** Everything in one object, as `settings.get` returns it (defaults applied). */
export const SettingsSchema = z.object({
  context: ContextSettingsSchema,
  limits: LimitsSettingsSchema,
  resume: ResumeSettingsSchema,
  policy: PolicySettingsSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;
