/**
 * The rule table for an agent's permission prompts (SPEC 5.18). No model decides a prompt: a rule
 * settles it, or the captain's own turn does, or the owner does. Pure.
 *
 * A prompt carries the tool's title, which is the tool name and, for most tools, a summary of its
 * arguments. The table reads that text only.
 */

import { mcpToolOf } from "../runs/permissions.ts";

export type PermissionVerdict =
  /** majhi's own read-only tool: allow once. */
  | { decision: "allow"; why: string }
  /** A pattern that must never be allowed unseen: reject once. */
  | { decision: "deny"; why: string }
  /** Nothing to read in the prompt: it is never settled by anyone but the owner. */
  | { decision: "unreadable"; why: string }
  /** No rule settles it: the captain's turn looks, or the owner. */
  | { decision: "unsettled" };

/** Text that says nothing: an ellipsis, punctuation, or nothing. */
function unreadable(title: string): boolean {
  return title.replace(/[\s.…_\-"'`*]/g, "") === "";
}

/** Arguments that can destroy work, leak a secret or run unseen code. */
const DANGEROUS: readonly { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, why: "it deletes files recursively or by force" },
  { re: /\bgit\s+push\b[^\n]*(--force|-f\b|--force-with-lease)/i, why: "it force-pushes" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, why: "it throws away uncommitted work" },
  { re: /\bsudo\b/i, why: "it runs as root" },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, why: "it runs a downloaded script" },
  { re: /\bchmod\s+(-R\s+)?0?777\b/i, why: "it opens file permissions to everyone" },
  {
    re: /(^|[\s/"'])\.ssh\b|id_(rsa|ed25519)|\.aws\/credentials|\.npmrc|\.netrc/i,
    why: "it touches keys or credentials",
  },
  { re: /\b(drop|truncate)\s+(table|database)\b/i, why: "it drops data" },
  { re: /\bmkfs\b|\bdd\s+if=/i, why: "it writes to a disk" },
];

/** majhi's own tools that only read: allowed without a model. */
const READ_TOOL = /^mcp__majhi[\w-]*__(list|logs|status|get|read|search)[\w]*$/i;

export function permissionVerdict(title: string): PermissionVerdict {
  const text = title.trim();
  if (unreadable(text)) {
    return {
      decision: "unreadable",
      why: "the prompt has no readable tool text, so only the owner can answer it",
    };
  }
  for (const rule of DANGEROUS) {
    if (rule.re.test(text)) return { decision: "deny", why: `${rule.why}, so the rules reject it` };
  }
  if (READ_TOOL.test(text)) return { decision: "allow", why: "it is a read-only tool of majhi" };
  return { decision: "unsettled" };
}

/** majhi's container tools: they act on this task's own previews and services only. */
const TASK_CONTAINER_TOOL = /^(preview_build|preview_run|preview_stop|service_start|service_stop|list|logs)$/;

/**
 * Whether a rule covers this tool for the whole task, so one "Allow for this task" settles every later
 * call: majhi's read-only tools, and the tools of the task's own previews and services. Anything else
 * is a judgment call and stays an Allow once.
 */
export function coveredForTask(title: string): boolean {
  if (READ_TOOL.test(title.trim())) return true;
  const tool = mcpToolOf(title);
  return tool?.server === "majhi-containers" && TASK_CONTAINER_TOOL.test(tool.tool);
}

/**
 * The option the captain's yes becomes: for a tool a rule covers, "Allow for this task" instead of the
 * one-shot Allow once, so repeated legitimate calls do not ask again. Else the option as given.
 */
export function answerFor(
  title: string,
  options: readonly { id: string; kind: string }[],
  chosen: string,
): string {
  if (options.find((o) => o.id === chosen)?.kind !== "allow_once" || !coveredForTask(title)) return chosen;
  return options.find((o) => o.kind === "allow_always")?.id ?? chosen;
}
