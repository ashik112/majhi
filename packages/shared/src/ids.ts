import { z } from "zod";

/** Lowercase id used for accounts, orgs, agents and connections: `claude-acme-2`, `globex`, `majhi-boss`. */
export const IdSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "Use lowercase letters, digits and dashes, starting with a letter or digit",
  );

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
