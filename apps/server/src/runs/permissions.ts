import type { PermissionAsk } from "@majhi/acp";
import type { Perm } from "@majhi/shared";

/** Any `git ... push`, including ones inside `sh -c "..."` or a longer command line. Errs toward asking. */
const GIT_PUSH = /\bgit\b[^;&|\n]*?\bpush\b/i;
/** Opening or merging a merge request from the command line. */
const MR_CLI = /\b(?:gh\s+pr|glab\s+mr)\b/i;

/** What an ACP tool kind needs, by DECISIONS: nothing for reads, `edit`, `shell`, `push` or `mr`. */
export type Need = "none" | Perm | "unknown";

/** The permission a request needs. `execute` needs `shell`, or `push` or `mr` for those commands. */
export function neededPerm(ask: Pick<PermissionAsk, "kind" | "command" | "title">): Need {
  switch (ask.kind) {
    case "read":
    case "search":
    case "fetch":
    case "think":
      return "none";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "execute": {
      const command = ask.command ?? ask.title;
      if (GIT_PUSH.test(command)) return "push";
      if (MR_CLI.test(command)) return "mr";
      return "shell";
    }
    default:
      return "unknown";
  }
}

export type Decision = { action: "allow"; option: string; via: "perms" | "task" } | { action: "ask" };

export interface DecideContext {
  perms: readonly Perm[];
  /** True when the owner chose "allow for this task" for this kind before. */
  rememberedFor: (kind: string) => boolean;
}

/**
 * Decides a permission request without the owner (DECISIONS): allowed when the agent's perms
 * cover it, or when the owner already allowed this kind for the task. Pushes and merge
 * requests are never covered by a remembered choice. Everything else asks.
 */
export function decidePermission(ask: PermissionAsk, ctx: DecideContext): Decision {
  const option =
    ask.options.find((o) => o.kind === "allow_once") ?? ask.options.find((o) => o.kind === "allow_always");
  if (option === undefined) return { action: "ask" };
  // majhi's own MCP tools are gated by majhi's approval policy (cards with Undo), so the CLI's
  // extra "may I call this tool" prompt is only noise. Anything else still follows the rules below.
  if (isMajhiTool(ask.title)) return { action: "allow", option: option.id, via: "perms" };
  const need = neededPerm(ask);
  if (need === "none") return { action: "allow", option: option.id, via: "perms" };
  if (need !== "unknown" && ctx.perms.includes(need))
    return { action: "allow", option: option.id, via: "perms" };
  const guarded = need === "push" || need === "mr";
  if (!guarded && ctx.rememberedFor(ask.kind ?? "other")) {
    return { action: "allow", option: option.id, via: "task" };
  }
  return { action: "ask" };
}

/** A call to one of majhi's own MCP servers, as the CLIs name it: `mcp__majhi-admin__<tool>`. */
export function isMajhiTool(title: string): boolean {
  return /^mcp__majhi-(admin|decide)__[a-z0-9_]+$/.test(title.trim());
}
