import { z } from "zod";
import { ContainerCpusSchema, ContainerMemorySchema, ImageRefSchema } from "./containers.ts";

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

/**
 * Who a commit is attributed to (5.7): the agent as committer and a `Majhi-Task` trailer. On unless
 * turned off here, for an org or for a project; the project wins, then the org, then this.
 * A change applies to runs launched after it. Checkpoints follow it at once.
 */
export const CommitsSettingsSchema = z.strictObject({
  attribution: z.boolean().default(true),
});
export type CommitsSettings = z.infer<typeof CommitsSettingsSchema>;
export const CommitsPatchSchema = z.strictObject({ attribution: z.boolean() }).partial();
export type CommitsPatch = z.infer<typeof CommitsPatchSchema>;

/** Teams in a room (5.3). Orgs can override `max_agent_turns`. */
const roomFields = {
  /** Agent-to-agent turns without an owner message before the task pauses and asks (loop guard). */
  max_agent_turns: z.number().int().min(1).max(200),
  /** Rounds of the build and review loop before it stops and asks the owner. */
  review_rounds: z.number().int().min(1).max(50),
};
export const RoomSettingsSchema = z.strictObject({
  max_agent_turns: roomFields.max_agent_turns.default(12),
  review_rounds: roomFields.review_rounds.default(5),
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;
export const RoomPatchSchema = z.strictObject(roomFields).partial();

/** Cleanup of done tasks. */
const cleanupFields = {
  /** Tasks done for longer than this many days are offered for cleanup. */
  after_days: z.number().int().min(1).max(3650),
};
export const CleanupSettingsSchema = z.strictObject({
  after_days: cleanupFields.after_days.default(30),
});
export type CleanupSettings = z.infer<typeof CleanupSettingsSchema>;
export const CleanupPatchSchema = z.strictObject(cleanupFields).partial();

/** Memory curation (5.6). */
const memoryFields = {
  /**
   * The lift over chance ((n*p-1)/(n-1), 0 a guess, 1 certain) an answer needs, on top of the
   * decisions gate, before a fact is kept or dropped without the owner. Stricter than the gate.
   */
  auto_threshold: z.number().min(0).max(1),
  /** Nothing is kept or dropped on its own: every fact waits for the owner. */
  review_all: z.boolean(),
  /** The agent that reads the room after a task. Default: the boss. */
  // Same shape as an agent id; accounts.ts imports this file, so it is not imported here.
  housekeeper: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use an agent id"),
  /** The model it runs on. Default: the cheapest its account offers. */
  housekeeper_model: z.string().trim().min(1).max(100),
};
export const MemorySettingsSchema = z.strictObject({
  auto_threshold: memoryFields.auto_threshold.default(0.4),
  review_all: memoryFields.review_all.default(false),
  housekeeper: memoryFields.housekeeper.optional(),
  housekeeper_model: memoryFields.housekeeper_model.optional(),
});
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;
/** `null` puts the default back: the boss as Housekeeper, the cheapest model. */
export const MemoryPatchSchema = z
  .strictObject({
    ...memoryFields,
    housekeeper: memoryFields.housekeeper.nullable(),
    housekeeper_model: memoryFields.housekeeper_model.nullable(),
  })
  .partial();
export type MemoryPatch = z.infer<typeof MemoryPatchSchema>;

/** The owner's editor (SPEC 11). The host helper opens files and folders in it. */
export const EditorAppSchema = z.enum(["vscode", "cursor"]);
export type EditorApp = z.infer<typeof EditorAppSchema>;
export const EDITOR_LABEL: Record<EditorApp, string> = { vscode: "VS Code", cursor: "Cursor" };

const editorFields = { app: EditorAppSchema };
export const EditorSettingsSchema = z.strictObject({ app: editorFields.app.default("vscode") });
export type EditorSettings = z.infer<typeof EditorSettingsSchema>;
export const EditorPatchSchema = z.strictObject(editorFields).partial();
/** Containers majhi runs for agents: previews and test services (PRV-53). */
const containersFields = {
  /** Service images the owner allowed. Changed only by `containers.images.allow` and `.remove`. */
  images: z.array(ImageRefSchema).max(100),
  /** CPUs per preview or service container. */
  cpus: ContainerCpusSchema,
  /** Memory per preview or service container. */
  memory: ContainerMemorySchema,
  /** Previews and services running at once in one task. */
  per_task: z.number().int().min(1).max(10),
  /** CPUs of the preview builder. */
  build_cpus: ContainerCpusSchema,
  /** Memory of the preview builder. */
  build_memory: ContainerMemorySchema,
};
export const ContainersSettingsSchema = z.strictObject({
  images: containersFields.images.default([]),
  cpus: containersFields.cpus.default(1),
  memory: containersFields.memory.default("2g"),
  per_task: containersFields.per_task.default(3),
  build_cpus: containersFields.build_cpus.default(2),
  build_memory: containersFields.build_memory.default("4g"),
});
export type ContainersSettings = z.infer<typeof ContainersSettingsSchema>;
/** What majhi.yaml may hold and what majhi writes: the limits and the image list. */
export const ContainersFilePatchSchema = z.strictObject(containersFields).partial();
/** What `settings.set` accepts: the limits, never `images`, so every new image goes through its own card. */
export const ContainersPatchSchema = ContainersFilePatchSchema.omit({ images: true });
export type ContainersPatch = z.infer<typeof ContainersPatchSchema>;

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

const RULE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * "Always allow this agent to run this command", saved when the owner ticks the box on an approval
 * card. It has exactly one scope: a `task` (only that task) or an `org` (every task in that org).
 * It only turns a card that would wait into one that runs, and never blocks anything.
 */
export const AllowRuleSchema = z
  .strictObject({
    agent: z.string().regex(RULE_ID),
    command: z.string().min(1),
    task: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/)
      .optional(),
    org: z.string().regex(RULE_ID).optional(),
  })
  .refine((rule) => (rule.task === undefined) !== (rule.org === undefined), {
    message: "A rule has exactly one of task or org",
  });
export type AllowRule = z.infer<typeof AllowRuleSchema>;

export const PolicySettingsSchema = z.strictObject({
  read: ApprovalModeSchema.default("auto"),
  change: ApprovalModeSchema.default("when-asked"),
  destructive: ApprovalModeSchema.default("confirm"),
  outbound: ApprovalModeSchema.default("confirm"),
  /** Per-command overrides, by command name. */
  commands: z.record(z.string(), ApprovalModeSchema).default({}),
  /** Saved "always allow" choices from approval cards. */
  rules: z.array(AllowRuleSchema).default([]),
  /** Lets a rule cover a destructive command (remove, delete, forget). Off by default. */
  allow_destructive_rules: z.boolean().default(false),
});
export type PolicySettings = z.infer<typeof PolicySettingsSchema>;
/** `commands` and `rules`, when given, replace the whole map or list. */
export const PolicyPatchSchema = z
  .strictObject({
    read: ApprovalModeSchema,
    change: ApprovalModeSchema,
    destructive: ApprovalModeSchema,
    outbound: ApprovalModeSchema,
    commands: z.record(z.string(), ApprovalModeSchema),
    rules: z.array(AllowRuleSchema),
    allow_destructive_rules: z.boolean(),
  })
  .partial();
export type PolicyPatch = z.infer<typeof PolicyPatchSchema>;

/** Everything in one object, as `settings.get` returns it (defaults applied). */
export const SettingsSchema = z.object({
  context: ContextSettingsSchema,
  limits: LimitsSettingsSchema,
  resume: ResumeSettingsSchema,
  commits: CommitsSettingsSchema,
  rooms: RoomSettingsSchema,
  policy: PolicySettingsSchema,
  memory: MemorySettingsSchema,
  editor: EditorSettingsSchema,
  cleanup: CleanupSettingsSchema,
  containers: ContainersSettingsSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;
