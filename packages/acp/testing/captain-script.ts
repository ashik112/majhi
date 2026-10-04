/**
 * Captain script mode of the fake agent. A test writes `CAPTAIN_SCRIPT.json` into the captain
 * chat's task folder; the fake agent reads it on every turn there. The first rule whose `when`
 * matches the incoming prompt makes its MCP calls for real (over the session's own MCP servers),
 * says its text, and records each call's result in `CAPTAIN_SCRIPT_RESULTS.jsonl` beside the script.
 * The files are the only channel because the agent is a separate process. Erasable TypeScript only.
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const SCRIPT_FILE = "CAPTAIN_SCRIPT.json";
export const RESULTS_FILE = "CAPTAIN_SCRIPT_RESULTS.jsonl";

const StepSchema = z.union([
  /** An MCP tool call. `server` defaults to majhi-admin. */
  z.object({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
    server: z.string().optional(),
  }),
  z.object({ say: z.string() }),
]);

const RuleSchema = z.object({
  /** A regular expression's source, matched against the whole prompt. */
  when: z.string(),
  flags: z.string().default(""),
  steps: z.array(StepSchema),
});

const ScriptSchema = z.object({ rules: z.array(RuleSchema) });

export type ScriptStep = z.input<typeof StepSchema>;
export type ScriptRule = z.infer<typeof RuleSchema>;

/** What the agent recorded for one call it made. */
export const ResultSchema = z.object({
  rule: z.number(),
  tool: z.string(),
  args: z.unknown(),
  text: z.string(),
  isError: z.boolean(),
});
export type ScriptResult = z.infer<typeof ResultSchema>;

/** The first rule matching the prompt, with its index, or undefined when there is no script or no match. */
export async function matchRule(
  cwd: string,
  prompt: string,
): Promise<{ index: number; rule: ScriptRule } | undefined> {
  let script: z.infer<typeof ScriptSchema>;
  try {
    script = ScriptSchema.parse(JSON.parse(await readFile(join(cwd, SCRIPT_FILE), "utf8")) as unknown);
  } catch {
    return undefined;
  }
  const index = script.rules.findIndex((r) => new RegExp(r.when, r.flags).test(prompt));
  const rule = script.rules[index];
  return rule === undefined ? undefined : { index, rule };
}

export async function recordResult(cwd: string, result: ScriptResult): Promise<void> {
  await appendFile(join(cwd, RESULTS_FILE), `${JSON.stringify(result)}\n`);
}
