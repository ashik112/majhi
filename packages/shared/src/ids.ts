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
