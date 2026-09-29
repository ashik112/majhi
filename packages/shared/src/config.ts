import { z } from "zod";
import { AccountConfigSchema, IdSchema, OrgConfigSchema } from "./accounts.ts";

/** A path in majhi.yaml: absolute, or relative to the owner's home with `~/`. */
export const ConfigPath = z
  .string()
  .trim()
  .min(1, { message: "Path is empty", abort: true })
  .refine((p) => p.startsWith("/") || p === "~" || p.startsWith("~/"), {
    message: "Use an absolute path, or one starting with ~/",
  });

/**
 * Sections later phases own. Phase 0 only checks that they are maps, so a
 * hand-written file with them still loads. Each phase replaces its entry with
 * a real schema.
 */
const LaterSection = z.record(z.string(), z.unknown());

export const MajhiConfigSchema = z.strictObject({
  workspaces: z.array(ConfigPath).min(1, "Add at least one workspace root"),
  tasks_dir: ConfigPath.optional(),
  decisions: LaterSection.optional(),
  context: LaterSection.optional(),
  limits: LaterSection.optional(),
  boss: z.string().trim().min(1).optional(),
  accounts: z.record(IdSchema, AccountConfigSchema).optional(),
  orgs: z.record(IdSchema, OrgConfigSchema).optional(),
  projects: LaterSection.optional(),
});

export type MajhiConfig = z.infer<typeof MajhiConfigSchema>;

/** Name of the directory created under the first root when tasks_dir is not set. */
export const DEFAULT_TASKS_DIR_NAME = ".majhi";
