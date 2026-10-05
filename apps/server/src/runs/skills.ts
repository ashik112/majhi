import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { RunMount } from "@majhi/acp";
import { removeRunFiles, runFilesRoot } from "../connections/run-files.ts";
import { ownerOnlyDir } from "../connections/service.ts";
import { copyFolder } from "../skills/files.ts";
import type { SkillStore } from "../skills/store.ts";

/** What a run holds of its agent's skills: a folder of read-only copies, and how the agent finds them. */
export interface RunSkills {
  /** The run's own folder, mounted read-only and removed when the session ends. */
  dir: string;
  mounts: RunMount[];
  /**
   * One short line for the session's first prompt, or "" when the CLI lists the skills itself. Never
   * a list and never a skill's text: the agent reads a SKILL.md only when the work calls for it.
   */
  note: string;
  /** Each skill's name and description, for `majhi-skills`. */
  items: { name: string; description: string }[];
  /** Enabled skills that are no longer installed. */
  missing: string[];
}

export interface RunSkillsDeps {
  store: Pick<SkillStore, "get" | "pathOf">;
  majhiHome: string;
}

export interface RunSkillsOptions {
  /**
   * Where the CLI looks for skills itself (`<task folder>/.claude/skills`). Set for Claude Code in a
   * runner container: the copies show up there and the CLI lists their names and descriptions, so
   * the prompt carries nothing. Unset: a one-line note and `majhi-skills`.
   */
  overlayTarget?: string | undefined;
}

/**
 * Copies only the skills this agent has enabled into a folder of the run's own, like the run's
 * connection files: `<majhi home>/run/connections/skills-<id>/<name>/`, a place a run may mount
 * read-only. Agents of one account share a config home, so nothing goes in its shared `skills`
 * folder (SPEC 5.2). Undefined when the agent has none, so most runs have no folder at all.
 */
export async function prepareRunSkills(
  deps: RunSkillsDeps,
  enabled: readonly string[],
  options: RunSkillsOptions = {},
): Promise<RunSkills | undefined> {
  const skills = [];
  const missing: string[] = [];
  for (const name of new Set(enabled)) {
    const skill = await deps.store.get(name);
    if (skill === undefined) missing.push(name);
    else skills.push(skill);
  }
  if (skills.length === 0)
    return missing.length === 0 ? undefined : { dir: "", mounts: [], note: "", items: [], missing };
  const root = runFilesRoot(deps.majhiHome);
  await ownerOnlyDir(root);
  const dir = join(root, `skills-${randomBytes(8).toString("hex")}`);
  await ownerOnlyDir(dir);
  try {
    for (const skill of skills) await copyFolder(deps.store.pathOf(skill.name), join(dir, skill.name));
  } catch (err) {
    await removeRunFiles(dir);
    throw err;
  }
  const overlay = options.overlayTarget;
  return {
    dir,
    mounts: [{ path: dir, readOnly: true, ...(overlay === undefined ? {} : { target: overlay }) }],
    note: overlay === undefined ? skillsNote(skills.length) : "",
    items: skills.map((s) => ({ name: s.name, description: s.description })),
    missing,
  };
}

/** The prompt line when the CLI does not list skills itself. About 60 tokens however many skills there are. */
export function skillsNote(count: number): string {
  return `The owner turned on ${count} skill${count === 1 ? "" : "s"} for you (instructions for specific kinds of work). Look one up only when the work calls for it: call the find tool of majhi-skills with a few words, then read the SKILL.md it names and follow it.`;
}
