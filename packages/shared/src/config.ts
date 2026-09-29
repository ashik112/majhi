import { z } from "zod";

/** A path in hub.yaml: absolute, or relative to the owner's home with `~/`. */
export const ConfigPath = z
  .string()
  .trim()
  .min(1, "Path is empty")
  .refine((p) => p.startsWith("/") || p === "~" || p.startsWith("~/"), {
    message: "Use an absolute path, or one starting with ~/",
  });

/**
 * Sections later phases own. Phase 0 only checks that they are maps, so a
 * hand-written file with them still loads. Each phase replaces its entry with
 * a real schema.
 */
const LaterSection = z.record(z.string(), z.unknown());

export const HubConfigSchema = z.strictObject({
  workspaces: z.array(ConfigPath).min(1, "Add at least one workspace root"),
  tasks_dir: ConfigPath.optional(),
  decisions: LaterSection.optional(),
  context: LaterSection.optional(),
  limits: LaterSection.optional(),
  boss: z.string().trim().min(1).optional(),
  accounts: LaterSection.optional(),
  orgs: LaterSection.optional(),
  projects: LaterSection.optional(),
});

export type HubConfig = z.infer<typeof HubConfigSchema>;

/** Name of the directory created under the first root when tasks_dir is not set. */
export const DEFAULT_TASKS_DIR_NAME = ".hub";
