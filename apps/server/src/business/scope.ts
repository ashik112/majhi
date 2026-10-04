import { UserError } from "../errors.ts";

/**
 * Who reads or writes business memory (SPEC 5.19). The owner sees everything. A captain lane and an
 * agent are tied to one workspace and see that workspace's rows and the business-wide rows (no org).
 * A captain with no lane (the boss outside any workspace) is not restricted but never sees owner-only
 * contacts.
 */
export type BusinessActor =
  | { kind: "owner" }
  | { kind: "captain"; org?: string | undefined }
  | { kind: "agent"; id: string; org: string };

/** The `by` column: `owner`, `captain` or an agent id. */
export function actorBy(actor: BusinessActor): string {
  return actor.kind === "agent" ? actor.id : actor.kind;
}

/** The one workspace an actor is tied to, or undefined when it is not. */
export function tiedOrg(actor: BusinessActor): string | undefined {
  return actor.kind === "owner" ? undefined : actor.org;
}

/** May this actor see a row of this workspace (`null` is the whole business)? */
export function canSee(actor: BusinessActor, rowOrg: string | null): boolean {
  const own = tiedOrg(actor);
  return own === undefined || rowOrg === null || rowOrg === own;
}

/** May this actor change a row of this workspace? A tied actor changes only its own workspace's rows. */
export function canChange(actor: BusinessActor, rowOrg: string | null): boolean {
  const own = tiedOrg(actor);
  if (actor.kind === "owner") return true;
  if (own === undefined) return true;
  return rowOrg === own;
}

export interface ScopeFilter {
  org?: string | undefined;
  businessOnly?: boolean | undefined;
}

/**
 * The SQL that keeps a query inside what the actor may see and asked for. `column` is the org column.
 * A tied actor that names another workspace is refused.
 */
export function orgWhere(
  column: string,
  actor: BusinessActor,
  filter: ScopeFilter,
): { sql: string; args: string[] } {
  const own = tiedOrg(actor);
  if (own !== undefined && filter.org !== undefined && filter.org !== own) {
    throw new UserError("That belongs to another workspace.", 409);
  }
  if (filter.businessOnly === true) return { sql: `${column} IS NULL`, args: [] };
  const org = own ?? filter.org;
  if (org === undefined) return { sql: "1 = 1", args: [] };
  return { sql: `(${column} IS NULL OR ${column} = ?)`, args: [org] };
}

/**
 * The workspace a new row goes to. A tied actor writes to its own workspace (and may not name another);
 * the owner and an unscoped captain write to the named workspace, or to the whole business when none.
 */
export function targetOrg(actor: BusinessActor, asked: string | undefined): string | null {
  const own = tiedOrg(actor);
  if (own === undefined) return asked ?? null;
  if (asked !== undefined && asked !== own) {
    throw new UserError("That belongs to another workspace.", 409);
  }
  return own;
}

/** A row the actor may not see is reported as missing, so its existence is not revealed. */
export function missing(what: string, id: number): UserError {
  return new UserError(`${what} ${id} does not exist.`, 404);
}

/** Splits text into a JSON array column's string list. */
export function parseList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A list of tags: lower case, trimmed, no repeats. */
export function cleanTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))];
}

/** Escapes the LIKE wildcards of a user's words. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
