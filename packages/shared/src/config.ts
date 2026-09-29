import { z } from "zod";
import { AccountConfigSchema, IdSchema, OrgConfigSchema } from "./accounts.ts";
import { DecisionPatchSchema } from "./decisions.ts";
import { ContextPatchSchema, LimitsPatchSchema, PolicyPatchSchema, ResumePatchSchema } from "./settings.ts";
import { ProjectConfigSchema } from "./tasks.ts";

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
  /** Approval policy for the boss's commands (5.16). Changing it is destructive. */
  policy: PolicyPatchSchema.optional(),
  boss: z.string().trim().min(1).optional(),
  accounts: z.record(IdSchema, AccountConfigSchema).optional(),
  orgs: z.record(IdSchema, OrgConfigSchema).optional(),
  projects: z.record(IdSchema, ProjectConfigSchema).optional(),
});

export type MajhiConfig = z.infer<typeof MajhiConfigSchema>;

/** Name of the directory created under the first root when tasks_dir is not set. */
export const DEFAULT_TASKS_DIR_NAME = ".majhi";
