import { readFile } from "node:fs/promises";
import {
  type ConnectionConfig,
  ConnectionConfigSchema,
  duplicateConnectionIds,
  GLOBAL_CONNECTIONS,
  type AccountConfig,
  AccountConfigSchema,
  IdSchema,
  type OrgConfig,
  OrgsConfigSchema,
  PRIVATE,
  PRIVATE_COLOR,
  PRIVATE_NAME,
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
  connections?: Record<string, ConnectionConfig> | undefined;
  /** Projects that parse. An entry with errors is left out, so one bad project hides nothing else. */
  projects: Record<string, ProjectConfig>;
  boss: string | undefined;
}

const SectionsSchema = z.looseObject({
  orgs: OrgsConfigSchema.optional(),
  connections: z.record(IdSchema, ConnectionConfigSchema).optional(),
  accounts: z.record(IdSchema, AccountConfigSchema).optional(),
  projects: z.record(z.string(), z.unknown()).optional(),
  boss: z.string().trim().min(1).optional(),
}).superRefine((sections, ctx) => {
  for (const { id, orgs } of duplicateConnectionIds({ ...sections.orgs, [GLOBAL_CONNECTIONS]: { connections: sections.connections } })) {
    ctx.addIssue({ code: "custom", path: ["connections", id], message: `Connection ${id} is in both ${orgs.join(" and ")}. Connection ids must be unique.` });
  }
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
      return { exists: false, orgs: withBuiltInOrgs({}), accounts: {}, projects: {}, boss: undefined };
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
    orgs: withBuiltInOrgs(parsed.data.orgs ?? {}),
    accounts: parsed.data.accounts ?? {},
    connections: parsed.data.connections ?? {},
    projects: validProjects(parsed.data.projects ?? {}),
    boss: parsed.data.boss,
  };
}

/** The built-in Private org, as it reads when majhi.yaml has no entry for it. */
export const PRIVATE_DEFAULTS: OrgConfig = { name: PRIVATE_NAME, color: PRIVATE_COLOR };

/**
 * Orgs as the rest of the server sees them: `private` is always there and always first, whether
 * or not majhi.yaml has an entry. An entry only exists once the owner changes its settings.
 */
export function withBuiltInOrgs(orgs: Record<string, OrgConfig>): Record<string, OrgConfig> {
  const { [PRIVATE]: own, ...rest } = orgs;
  return { [PRIVATE]: own ?? PRIVATE_DEFAULTS, ...rest };
}

function validProjects(raw: Record<string, unknown>): Record<string, ProjectConfig> {
  const out: Record<string, ProjectConfig> = {};
  for (const [id, value] of Object.entries(raw)) {
    const parsed = ProjectConfigSchema.safeParse(value);
    if (IdSchema.safeParse(id).success && parsed.success) out[id] = parsed.data;
  }
  return out;
}

/** Connection scopes only. The Global entry never becomes an org, project scope or account owner. */
export function connectionScopes(sections: Pick<ConfigSections, "orgs" | "connections">): Record<string, OrgConfig> {
  return { ...sections.orgs, [GLOBAL_CONNECTIONS]: { name: "Global", connections: sections.connections ?? {} } };
}
