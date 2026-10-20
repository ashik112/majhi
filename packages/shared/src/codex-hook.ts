import { z } from "zod";

/**
 * What Codex's PreToolUse hook sends to majhi (docker/codex/hook.mjs posts it as it came), and what majhi
 * answers. Codex 0.158.0 writes the payload to the hook's stdin before every tool call and adds fields from time
 * to time, so only the ones majhi reads are named. `tool_name` is `Bash` for a shell command, `apply_patch` for
 * a file edit, `mcp__<server>__<tool>` for an MCP call (Codex swaps every character outside letters, digits and
 * `_` in the server and tool for `_`), or the name of one of Codex's own tools.
 */
export const CodexHookPayloadSchema = z.looseObject({
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string().min(1).max(300),
  tool_input: z.unknown(),
  /** Where the session runs. A patch names its files relative to it. */
  cwd: z.string().min(1).max(4_000),
  tool_use_id: z.string().max(300).optional(),
});
export type CodexHookPayload = z.infer<typeof CodexHookPayloadSchema>;

/** `tool_input` of `Bash`, and of `apply_patch` (the patch text): one string, `command`. */
export const CodexHookCommandInputSchema = z.looseObject({ command: z.string().min(1) });

export const CodexHookVerdictSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  /** What the agent reads when the call is denied. */
  reason: z.string().max(2_000).optional(),
});
export type CodexHookVerdict = z.infer<typeof CodexHookVerdictSchema>;
