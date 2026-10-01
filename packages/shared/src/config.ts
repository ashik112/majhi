import { z } from "zod";
import { AccountConfigSchema, IdSchema, OrgConfigSchema } from "./accounts.ts";
import { DecisionPatchSchema } from "./decisions.ts";
import {
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
  resume: ResumePatchSchema.optional(),
  /** Agent attribution in commits (5.7). */
  commits: CommitsPatchSchema.optional(),
  /** Teams in a room: the loop guard and review rounds (5.3). */
  rooms: RoomPatchSchema.optional(),
  /** Memory curation: the auto threshold, review of every fact, the Housekeeper (5.6). */
  memory: MemoryPatchSchema.optional(),
  /** Which editor "Open in editor" uses: VS Code or Cursor. */
  editor: EditorPatchSchema.optional(),
  /** Cleanup of done tasks: after how many days (PRV-39). */
  cleanup: CleanupPatchSchema.optional(),
  /** Notifications when something needs the owner. */
  notifications: NotificationsFilePatchSchema.optional(),
  /** Previews and test services majhi runs for agents (PRV-53): the allowed images and the limits. */
  containers: ContainersFilePatchSchema.optional(),
  /** Weekly token and cost budgets per org and account, with alerts at 80% and 100% (PRV-40). */
  budgets: BudgetsFilePatchSchema.optional(),
  /** Approval policy for the boss's commands (5.16). Changing it is destructive. */
  policy: PolicyPatchSchema.optional(),
  boss: z.string().trim().min(1).optional(),
  /** The owner's rows of the price table (Phase 2c), in dollars per million tokens. */
  prices: PricesConfigSchema.optional(),
  accounts: z.record(IdSchema, AccountConfigSchema).optional(),
  orgs: z.record(IdSchema, OrgConfigSchema).optional(),
  projects: z.record(IdSchema, ProjectConfigSchema).optional(),
});

export type MajhiConfig = z.infer<typeof MajhiConfigSchema>;

/** Name of the directory created under the first root when tasks_dir is not set. */
export const DEFAULT_TASKS_DIR_NAME = ".majhi";
