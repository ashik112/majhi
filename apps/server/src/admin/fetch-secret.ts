import { IdSchema, TaskIdSchema } from "@majhi/shared";
import { z } from "zod";

export const SAVE_FROM_SCRIPT_TOOL = "majhi_secrets_saveFromScript";
export const WITHDRAW_SECRET_TOOL = "majhi_secrets_withdrawRequest";

/** The longest value a secret holds, as `secrets.save` allows. */
export const FETCHED_VALUE_MAX = 8192;

export const SaveFromScriptInputSchema = z
  .object({
    /** The pending secret request this answers: saved under its name, and the asking agent is told. */
    task: TaskIdSchema.optional(),
    item: z.string().min(1).optional(),
    /** Without a request: the name to save under. */
    name: IdSchema.optional(),
    /** A short read-only script. What it prints is the secret. */
    script: z.string().min(1).max(4000),
    /** The workspace's connections the script needs, by id. */
    connections: z.array(IdSchema).max(10).default([]),
  })
  .refine((v) => (v.task === undefined) === (v.item === undefined), "Give both task and item, or neither")
  .refine((v) => v.task !== undefined || v.name !== undefined, "Give the request (task and item) or a name");
export type SaveFromScriptInput = z.infer<typeof SaveFromScriptInputSchema>;

export const WithdrawSecretInputSchema = z.object({
  task: TaskIdSchema,
  item: z.string().min(1),
  reason: z.string().min(1).max(300),
});

/** What the server runs a fetch with: the workspace's connections, in a throwaway runner. */
export interface ScriptFetch {
  run(input: { org: string; script: string; connections: readonly string[] }): Promise<string>;
  /** Whether the workspace (or Global) has this connection. Another workspace's never counts. */
  holds(org: string, connection: string): Promise<boolean>;
}

/** The value a script printed: its output without the trailing newline, or why it is no secret. */
export function fetchedValue(out: string): { value: string } | { problem: string } {
  const value = out.trim();
  if (value === "") return { problem: "The script printed nothing, so nothing was saved." };
  if (value.length > FETCHED_VALUE_MAX) {
    return { problem: `The script printed more than ${FETCHED_VALUE_MAX} characters, so nothing was saved.` };
  }
  return { value };
}
