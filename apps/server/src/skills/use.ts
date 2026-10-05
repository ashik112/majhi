import { sep } from "node:path";
import type { SessionEvent } from "@majhi/acp";

type ToolEvent = Extract<SessionEvent, { type: "tool" }>;

/** The skills a run has: their names, and the run's own folder of copies (where Codex reads them). */
export interface RunSkillSet {
  names: readonly string[];
  dir: string;
}

const SKILL_FILE = "SKILL.md";

/**
 * The installed skill a tool call used, or undefined. Two typed signals, never the title or any text:
 * - Claude Code's `Skill` tool, which the ACP layer already read into `event.skill`;
 * - a call whose locations include `<folder>/<name>/SKILL.md`, where the folder is the run's copies
 *   or the task's `.claude/skills` mount: an agent reading the skill it found with `majhi-skills`.
 * Only names the run has count, so a CLI's own skills and unknown names are left out.
 */
export function skillUsed(event: ToolEvent, skills: RunSkillSet | undefined): string | undefined {
  if (skills === undefined) return undefined;
  if (event.skill !== undefined) return skills.names.includes(event.skill) ? event.skill : undefined;
  for (const path of event.locations ?? []) {
    const name = skillFileOwner(path, skills);
    if (name !== undefined) return name;
  }
  return undefined;
}

function skillFileOwner(path: string, skills: RunSkillSet): string | undefined {
  const parts = path.split(sep);
  const file = parts.at(-1);
  const name = parts.at(-2);
  if (file !== SKILL_FILE || name === undefined || !skills.names.includes(name)) return undefined;
  const inCopies = skills.dir !== "" && path.startsWith(`${skills.dir}${sep}`);
  const inMount = parts.at(-3) === "skills" && parts.at(-4) === ".claude";
  return inCopies || inMount ? name : undefined;
}
