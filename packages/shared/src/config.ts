import { z } from "zod";
import { AccountConfigSchema, IdSchema, OrgsConfigSchema } from "./accounts.ts";
import { DecisionPatchSchema } from "./decisions.ts";
import { E2ePatchSchema } from "./e2e.ts";
import { GitAppsConfigSchema } from "./git-signin.ts";
import {
  AutonomyFilePatchSchema,
  BudgetsFilePatchSchema,
  CleanupPatchSchema,
  CommitsPatchSchema,
  ContainersFilePatchSchema,
  ContextPatchSchema,
  EditorPatchSchema,
  LimitsPatchSchema,
  MemoryPatchSchema,
  NotificationsFilePatchSchema,
  PolicyPatchSchema,
  ResumePatchSchema,
  RoomPatchSchema,
  TurnsPatchSchema,
} from "./settings.ts";
import { ProjectConfigSchema } from "./tasks.ts";
import { PricesConfigSchema } from "./usage.ts";

/** A path in majhi.yaml: absolute, or relative to the owner's home with `~/`. */
export const ConfigPath = z
  .string()
  .trim()
  .min(1, { message: "Path is empty", abort: true })
  .refine((p) => p.startsWith("/") || p === "~" || p.startsWith("~/"), {
    message: "Use an absolute path, or one starting with ~/",
  });

export const MajhiConfigSchema = z.strictObject({
  workspaces: z.array(ConfigPath).min(1, "Add at least one workspace root"),
  tasks_dir: ConfigPath.optional(),
  /** Decision provider (5.12). Written only when the owner changes a value. */
  decisions: DecisionPatchSchema.optional(),
  /** Defaults for every org (5.13). Written only when the owner changes a value. */
  context: ContextPatchSchema.optional(),
  limits: LimitsPatchSchema.optional(),
  /** Turn limits: length, idle time and tool calls per turn (PRV-96). */
  turns: TurnsPatchSchema.optional(),
  resume: ResumePatchSchema.optional(),
  /** Agent attribution in commits (5.7). */
  commits: CommitsPatchSchema.optional(),
  /** Teams in a room: the loop guard and review rounds (5.3). */
  rooms: RoomPatchSchema.optional(),
  /** Memory curation: the auto threshold, review of every fact, the Housekeeper (5.6). */
  memory: MemoryPatchSchema.optional(),
  /** Which editor "Open in editor" uses: VS Code or Cursor. */
  editor: EditorPatchSchema.optional(),
  /** Background e2e after a merge into main: which projects run the suite (PRV-72). */
  e2e: E2ePatchSchema.optional(),
  /** Cleanup of done tasks: after how many days (PRV-39). */
  cleanup: CleanupPatchSchema.optional(),
  /** Notifications when something needs the owner. */
  notifications: NotificationsFilePatchSchema.optional(),
  /** Previews and test services majhi runs for agents (PRV-53): the allowed images and the limits. */
  containers: ContainersFilePatchSchema.optional(),
  /** Weekly token and cost budgets per org and account, with alerts at 80% and 100% (PRV-40). */
  budgets: BudgetsFilePatchSchema.optional(),
  /** Autonomous mode (PRV-74): its caps, account floors, per-org push and merge, summary time and the owner's instructions. */
  autonomy: AutonomyFilePatchSchema.optional(),
  /** Approval policy for the captain's commands (5.16). Changing it is destructive. */
  policy: PolicyPatchSchema.optional(),
  boss: z.string().trim().min(1).optional(),
  /** The owner's rows of the price table (Phase 2c), in dollars per million tokens. */
  prices: PricesConfigSchema.optional(),
  accounts: z.record(IdSchema, AccountConfigSchema).optional(),
  orgs: OrgsConfigSchema.optional(),
  /** The OAuth apps majhi signs workspaces in to git hosts with. Public IDs and secret references only. */
  git_apps: GitAppsConfigSchema.optional(),
  projects: z.record(IdSchema, ProjectConfigSchema).optional(),
});

export type MajhiConfig = z.infer<typeof MajhiConfigSchema>;

/** Name of the directory created under the first root when tasks_dir is not set. */
export const DEFAULT_TASKS_DIR_NAME = ".majhi";
