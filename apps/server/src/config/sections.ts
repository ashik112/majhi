import { readFile } from "node:fs/promises";
import {
  type AccountConfig,
  AccountConfigSchema,
  IdSchema,
  type OrgConfig,
  OrgConfigSchema,
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
  boss: string | undefined;
}

const SectionsSchema = z.looseObject({
  orgs: z.record(IdSchema, OrgConfigSchema).optional(),
  accounts: z.record(IdSchema, AccountConfigSchema).optional(),
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
    if (errorCode(err) === "ENOENT") return { exists: false, orgs: {}, accounts: {}, boss: undefined };
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
    boss: parsed.data.boss,
  };
}
