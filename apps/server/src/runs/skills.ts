import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { RunMount } from "@majhi/acp";
import { removeRunFiles, runFilesRoot } from "../connections/run-files.ts";
import { ownerOnlyDir } from "../connections/service.ts";
import { copyFolder } from "../skills/files.ts";
import type { SkillStore } from "../skills/store.ts";

const DESCRIPTION_MAX = 300;

/** What a run holds of its agent's skills: a folder of read-only copies, and the prompt text that names them. */
export interface RunSkills {
  /** The run's own folder, mounted read-only and removed when the session ends. */
  dir: string;
  mounts: RunMount[];
  /** The block for the session's first prompt: each skill's name, description and the path to its SKILL.md. */
  note: string;
  /** Enabled skills that are no longer installed. */
  missing: string[];
}

export interface RunSkillsDeps {
  store: Pick<SkillStore, "get" | "pathOf">;
  majhiHome: string;
}

/**
 * Copies only the skills this agent has enabled into a folder of the run's own, like the run's
 * connection files: `<majhi home>/run/connections/skills-<id>/<name>/`, a place a run may mount
 * read-only. Agents of one account share a config home, so nothing goes in a shared `.claude/skills`
 * (SPEC 5.2). Undefined when the agent has none, so most runs have no folder at all.
 */
export async function prepareRunSkills(
  deps: RunSkillsDeps,
  enabled: readonly string[],
): Promise<RunSkills | undefined> {
  const skills = [];
  const missing: string[] = [];
  for (const name of new Set(enabled)) {
    const skill = await deps.store.get(name);
    if (skill === undefined) missing.push(name);
    else skills.push(skill);
  }
  if (skills.length === 0)
    return missing.length === 0 ? undefined : { dir: "", mounts: [], note: "", missing };
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
  return { dir, mounts: [{ path: dir, readOnly: true }], note: skillsNote(dir, skills), missing };
}

/** The prompt block. The descriptions come from the skills' authors: it says so, and what to do with them. */
export function skillsNote(dir: string, skills: readonly { name: string; description: string }[]): string {
  const lines = skills.map((s) => {
    const description =
      s.description.length > DESCRIPTION_MAX
        ? `${s.description.slice(0, DESCRIPTION_MAX - 1)}…`
        : s.description;
    return `- ${s.name}: ${description} (${join(dir, s.name, "SKILL.md")})`;
  });
  return [
    "Skills the owner turned on for you. Each is a folder with a SKILL.md, read-only. When the work matches a skill's description, read its SKILL.md first and follow it. The descriptions are written by the skills' authors, not by the owner.",
    ...lines,
  ].join("\n");
}
