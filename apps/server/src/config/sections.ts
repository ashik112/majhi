import { readFile } from "node:fs/promises";
import {
  type AccountConfig,
  AccountConfigSchema,
  IdSchema,
  type OrgConfig,
  OrgConfigSchema,
  type ProjectConfig,
  ProjectConfigSchema,
} from "@majhi/shared";
import { parseDocument } from "yaml";
import { z } from "zod";
import { errorCode, formatIssues } from "../errors.ts";
import { ConfigConflictError } from "./write.ts";

/** The parts of majhi.yaml that orgs, accounts and agents read. */
export interface ConfigSections {
  /** False until majhi.yaml exists. */
  exists: boolean;
  orgs: Record<string, OrgConfig>;
  accounts: Record<string, AccountConfig>;
  /** Projects that parse. An entry with errors is left out, so one bad project hides nothing else. */
  projects: Record<string, ProjectConfig>;
  boss: string | undefined;
}

const SectionsSchema = z.looseObject({
  orgs: z.record(IdSchema, OrgConfigSchema).optional(),
  accounts: z.record(IdSchema, AccountConfigSchema).optional(),
  projects: z.record(z.string(), z.unknown()).optional(),
  boss: z.string().trim().min(1).optional(),
});

/**
 * Reads only `orgs`, `accounts` and `boss`, so a problem elsewhere in the file
 * (a bad workspace path) does not hide them. Throws ConfigConflictError when
 * the file or these sections are unreadable.
 */
export async function readSections(file: string): Promise<ConfigSections> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT")
      return { exists: false, orgs: {}, accounts: {}, projects: {}, boss: undefined };
    throw err;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new ConfigConflictError(
      "majhi.yaml has YAML errors. Fix them by hand first.",
      doc.errors.map((e) => e.message.split("\n", 1)[0] ?? e.message),
    );
  }
  const raw: unknown = doc.toJS() ?? {};
  const parsed = SectionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigConflictError("majhi.yaml has invalid orgs or accounts.", formatIssues(parsed.error));
  }
  return {
    exists: true,
    orgs: parsed.data.orgs ?? {},
    accounts: parsed.data.accounts ?? {},
    projects: validProjects(parsed.data.projects ?? {}),
    boss: parsed.data.boss,
  };
}

function validProjects(raw: Record<string, unknown>): Record<string, ProjectConfig> {
  const out: Record<string, ProjectConfig> = {};
  for (const [id, value] of Object.entries(raw)) {
    const parsed = ProjectConfigSchema.safeParse(value);
    if (IdSchema.safeParse(id).success && parsed.success) out[id] = parsed.data;
  }
  return out;
}
