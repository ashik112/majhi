import { z } from "zod";
import { IdSchema } from "./ids.ts";

/**
 * Skills (SPEC 5.2, Phase 6): folders in the open Agent Skills format, a `SKILL.md` with YAML
 * frontmatter (`name`, `description`) and any files next to it. They are installed once into
 * `~/.majhi/skills/<name>/` and turned on per agent through the agent file's `skills` list.
 */

/** Lowercase letters, digits, hyphens and underscores: the name is a folder name and a list entry. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SkillNameSchema = z
  .string()
  .trim()
  .regex(SKILL_NAME, "A skill name is lowercase letters, digits, hyphens and underscores, at most 64");

/** Bounds that keep a hostile source from filling the disk or the prompt. */
export const SKILL_MAX_FILES = 500;
export const SKILL_MAX_BYTES = 10 * 1024 * 1024;
export const SKILL_DESCRIPTION_MAX = 1024;

export const SkillFileSchema = z.object({
  /** Relative to the skill's folder, with `/`. */
  path: z.string(),
  size: z.number().int().nonnegative(),
});
export type SkillFile = z.infer<typeof SkillFileSchema>;

/** What majhi records about where a skill came from (the lock's entry for it). */
export const SkillSourceSchema = z.object({
  /** As the owner gave it: `owner/repo`, a URL, `registry`, a folder path or `upload:<file name>`. */
  source: z.string(),
  /** How the CLI read it: github, gitlab, git, url, local, or `upload` for a zip. */
  sourceType: z.string(),
  /** Branch, tag or path inside the repo, when the source named one. */
  ref: z.string().optional(),
  /** The commit it was installed at, when the CLI's lock says. */
  commit: z.string().optional(),
});
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const SkillSchema = z.object({
  name: SkillNameSchema,
  description: z.string(),
  files: z.array(SkillFileSchema),
  source: z.string(),
  sourceType: z.string(),
  ref: z.string().optional(),
  commit: z.string().optional(),
  /** SHA-256 over the file paths and contents, so a changed skill shows as changed. */
  hash: z.string(),
  installedAt: z.string(),
  /** The agents that have it: the ones whose file lists it, and every agent when `defaultOn` (minus `optOut`). */
  agents: z.array(IdSchema),
  /** On for every agent, including agents created later, unless the agent opted out. */
  defaultOn: z.boolean(),
  /** Agents that turned it off, whatever else would give it to them. */
  optOut: z.array(IdSchema),
  /** Workspace rules: `on` or `off` for every agent of that workspace, agents created later included. */
  orgs: z.record(z.string(), z.enum(["on", "off"])).default({}),
});
export type Skill = z.infer<typeof SkillSchema>;

/** One skill in an install preview. Nothing is in the store yet. */
export const SkillPreviewItemSchema = z.object({
  name: SkillNameSchema,
  description: z.string(),
  files: z.array(SkillFileSchema),
  hash: z.string(),
  /** Set when a skill of this name is installed: confirming replaces it. */
  replaces: z.object({ source: z.string(), hash: z.string() }).optional(),
});
export type SkillPreviewItem = z.infer<typeof SkillPreviewItemSchema>;

export const SkillPreviewSchema = z.object({
  status: z.literal("preview"),
  /** Pass it as `confirm` to install what is shown. Valid for 30 minutes, once. */
  previewId: z.string(),
  source: SkillSourceSchema,
  skills: z.array(SkillPreviewItemSchema).min(1),
  expiresAt: z.string(),
});
export type SkillPreview = z.infer<typeof SkillPreviewSchema>;

export const SkillInstallResultSchema = z.discriminatedUnion("status", [
  SkillPreviewSchema,
  z.object({ status: z.literal("installed"), skills: z.array(SkillSchema).min(1) }),
  /** `skills.update` found the source unchanged. */
  z.object({ status: z.literal("unchanged"), skills: z.array(SkillSchema).min(1) }),
]);
export type SkillInstallResult = z.infer<typeof SkillInstallResultSchema>;

/** `skills.install`: a source or an upload, then, to commit, the preview's id. */
export const SkillInstallInputSchema = z
  .object({
    /** `owner/repo`, a repo or `tree/.../skills/<name>` URL, a git URL, a SKILL.md or archive URL, or a folder path majhi can read. */
    source: z.string().trim().min(1).max(2048).optional(),
    /** An upload id (`POST /api/uploads`) of a zip holding one or more skills. */
    upload: z.string().trim().min(1).max(100).optional(),
    /** Install only this skill of a source that holds several. */
    skill: SkillNameSchema.optional(),
    /** The org whose git login a private repo uses. */
    org: IdSchema.optional(),
    /** The id from the preview. Installs exactly what the preview showed. */
    confirm: z.string().trim().min(1).max(100).optional(),
    /** With `confirm`: also turn what was installed on for this one agent. */
    enable: IdSchema.optional(),
  })
  .refine((v) => v.confirm !== undefined || (v.source !== undefined) !== (v.upload !== undefined), {
    message: "Give a source or an upload, or the confirm id of a preview",
  })
  .refine((v) => v.enable === undefined || v.confirm !== undefined, {
    message: "enable goes with the confirm id of a preview",
  });
export type SkillInstallInput = z.infer<typeof SkillInstallInputSchema>;

/** `skills.update`: previews the newer copy, then commits it with the preview's id. */
export const SkillUpdateInputSchema = z.object({
  name: SkillNameSchema,
  org: IdSchema.optional(),
  confirm: z.string().trim().min(1).max(100).optional(),
});

export const SkillSearchResultSchema = z.object({
  /** `owner/repo/skill`, as skills.sh lists it. */
  id: z.string(),
  name: z.string(),
  /** The repo to review before installing. */
  source: z.string(),
  /** Pass to `skills.install` as `source`, with `skill`. */
  install: z.object({ source: z.string(), skill: z.string().optional() }),
  installs: z.number().int().nonnegative().optional(),
  url: z.string(),
  /** True when a skill of this name is already installed. */
  installed: z.boolean(),
});
export type SkillSearchResult = z.infer<typeof SkillSearchResultSchema>;

export const SkillNameInputSchema = z.object({ name: SkillNameSchema });
export const SkillAgentInputSchema = z.object({ name: SkillNameSchema, agent: IdSchema });

/** Who a bulk skills change reaches: every agent, every agent of one workspace (also later ones), or these agents. */
export const SkillTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("workspace"), org: z.string().trim().min(1).max(64) }),
  z.object({ kind: z.literal("agents"), agents: z.array(IdSchema).min(1).max(200) }),
]);
export type SkillTarget = z.infer<typeof SkillTargetSchema>;

/** `skills.setMany`: turn several skills on or off for a target, in one change. */
export const SkillSetManyInputSchema = z.object({
  skills: z.array(SkillNameSchema).min(1).max(500),
  target: SkillTargetSchema,
  on: z.boolean(),
});
export type SkillSetManyInput = z.infer<typeof SkillSetManyInputSchema>;
