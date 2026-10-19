import { z } from "zod";

/** Lowercase id used for accounts, orgs, agents and connections: `claude-acme-2`, `globex`, `majhi-boss`. */
export const IdSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "Use lowercase letters, digits and dashes, starting with a letter or digit",
  );

/** True when `value` is already a well-formed id, exactly as written (no trimming): the guard before an id becomes a path. */
export function isId(value: string): boolean {
  return IdSchema.safeParse(value).data === value;
}

/**
 * The built-in org for the owner's own accounts and projects. It always exists, even
 * without an entry in `orgs`, and cannot be removed or reused as a new org id.
 */
export const PRIVATE = "private";
/** The old id of the built-in org. Still read as `private`, and rewritten by the startup migration. */
export const LEGACY_PERSONAL = "personal";

/** Reads the old `personal` org id as `private`. Every other id is unchanged. */
export function currentOrgId(id: string): string {
  return id === LEGACY_PERSONAL ? PRIVATE : id;
}

/** An org id as written in a file or a command. An old `personal` reads as `private`. The one schema for org ids. */
export const OrgIdSchema = IdSchema.transform(currentOrgId);

/** Reference to an entry in `secrets.age`, like `secret:anthropic-personal`. */
export const SecretRefSchema = z.string().regex(/^secret:[a-z0-9][a-z0-9-]{0,62}$/, "Use secret:<name>");
export type SecretRef = z.infer<typeof SecretRefSchema>;

/** `GLX-420`, `LOCAL-9`. The org's key prefix plus a number. Also the task folder name. */
export const TaskIdSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/, "Task ids look like GLX-420");
export type TaskId = z.infer<typeof TaskIdSchema>;

/** A branch name to merge into, push, or open a merge request against. */
export const LocalBranchSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, "Not a branch name")
  .refine((b) => !b.includes(".."), "Not a branch name")
  .max(200);
