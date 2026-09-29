import { z } from "zod";

/**
 * Runtime settings in majhi.yaml that the owner or the boss can change live
 * (SPEC 5.7, 5.13, 5.16, 5.17). Every field has a default, so an empty
 * section means "use the defaults".
 */

/** Context budget (5.13). Orgs and agents can override `compact_at`. */
export const ContextSettingsSchema = z.strictObject({
  /** Compact when used / size reaches this. */
  compact_at: z.number().gt(0).lt(1).default(0.8),
  /** Native compaction must bring usage under this, else majhi hands off to a fresh session. */
  compact_target: z.number().gt(0).lt(1).default(0.4),
  /** Replace the session with a fresh one after this many turns. 0 turns it off. */
  max_turns: z.number().int().min(0).default(40),
});
export type ContextSettings = z.infer<typeof ContextSettingsSchema>;

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
export const LimitsSettingsSchema = z.strictObject({
  /** Agent processes running at once, across majhi. */
  agents_max: z.number().int().min(1).max(64).default(6),
  /** Agent processes running at once on one account. */
  per_account: z.number().int().min(1).max(16).default(2),
  /** Agent processes running at once in one task. */
  per_task: z.number().int().min(1).max(16).default(3),
  /** Stop an idle agent process after this long; it resumes on the next message. */
  idle_timeout: DurationSchema.default("10m"),
});
export type LimitsSettings = z.infer<typeof LimitsSettingsSchema>;

/** Resume after sleep, restarts, lost internet and crashes (5.7). */
export const ResumeSettingsSchema = z.strictObject({
  /** Resume interrupted runs on their own. Orgs can turn it off. */
  auto: z.boolean().default(true),
});
export type ResumeSettings = z.infer<typeof ResumeSettingsSchema>;

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

/** Everything in one object, as `settings.get` returns it (defaults applied). */
export const SettingsSchema = z.object({
  context: ContextSettingsSchema,
  limits: LimitsSettingsSchema,
  resume: ResumeSettingsSchema,
  policy: PolicySettingsSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;
