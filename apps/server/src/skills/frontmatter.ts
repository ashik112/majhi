import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_DESCRIPTION_MAX, SKILL_NAME } from "@majhi/shared";
import { parse } from "yaml";
import { errorCode, UserError } from "../errors.ts";

export interface SkillMeta {
  name: string;
  description: string;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** The `name` and `description` of a SKILL.md's text. Throws a UserError that says what is wrong. */
export function parseSkillMd(text: string): SkillMeta {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    throw new UserError(
      "SKILL.md must start with a YAML frontmatter block (---) holding name and description.",
    );
  }
  let data: unknown;
  try {
    data = parse(match[1] ?? "");
  } catch {
    throw new UserError("The frontmatter of SKILL.md is not valid YAML.");
  }
  if (typeof data !== "object" || data === null) {
    throw new UserError("The frontmatter of SKILL.md must list name and description.");
  }
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || !SKILL_NAME.test(name.trim())) {
    throw new UserError(
      "SKILL.md needs a name of lowercase letters, digits, hyphens and underscores, at most 64.",
    );
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new UserError("SKILL.md needs a description: the agent reads it to decide when to use the skill.");
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    throw new UserError(`The description is longer than ${SKILL_DESCRIPTION_MAX} characters.`);
  }
  return { name: name.trim(), description: description.replace(/\s+/g, " ").trim() };
}

/** Reads and checks the SKILL.md of a skill folder. */
export async function readSkillMeta(dir: string): Promise<SkillMeta> {
  let text: string;
  try {
    text = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") throw new UserError("The skill has no SKILL.md.");
    throw err;
  }
  return parseSkillMd(text);
}
