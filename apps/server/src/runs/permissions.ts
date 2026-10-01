import type { PermissionAsk } from "@majhi/acp";
import type { Perm } from "@majhi/shared";
import { classifyCommand, classifyTool, type GateConnection, type GateVerdict } from "../connections/gate.ts";

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
  // Background processes run commands, so they need what a shell command needs.
  if (isProcessTool(ask.title)) {
    return ctx.perms.includes("shell")
      ? { action: "allow", option: option.id, via: "perms" }
      : { action: "ask" };
  }
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

/** A call to majhi's background process server, which runs commands. */
export function isProcessTool(title: string): boolean {
  return /^mcp__majhi-processes__[a-z0-9_]+$/.test(title.trim());
}

/** A call to one of majhi's own MCP servers, as the CLIs name it: `mcp__majhi-admin__<tool>`. */
export function isMajhiTool(title: string): boolean {
  return /^mcp__majhi-(admin|decide|room|tasks|memory|connections)__[a-z0-9_]+$/.test(title.trim());
}

/** The server and tool of an MCP call: Claude names it `mcp__<server>__<tool>`, Codex `mcp.<server>.<tool>`. */
export function mcpToolOf(title: string | undefined): { server: string; tool: string } | undefined {
  const text = (title ?? "").trim();
  const claude = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_.-]+)$/.exec(text);
  if (claude?.[1] !== undefined && claude[2] !== undefined) return { server: claude[1], tool: claude[2] };
  const codex = /^mcp\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/.exec(text);
  if (codex?.[1] !== undefined && codex[2] !== undefined) return { server: codex[1], tool: codex[2] };
  return undefined;
}

/**
 * How a permission request counts against the run's connections (SPEC 5.14): a shell command by its
 * whole line, an MCP call by its server and tool. Codex asks about an MCP call without naming it,
 * so its tool call's title, found by id, names it.
 */
export function connectionVerdict(
  ask: PermissionAsk,
  held: readonly GateConnection[],
  toolTitle: (toolCallId: string) => string | undefined,
): GateVerdict {
  if (held.length === 0) return { kind: "other" };
  if (ask.kind === "execute" && ask.command !== undefined) return classifyCommand(ask.command, held);
  const tool =
    mcpToolOf(ask.title) ?? (ask.toolCallId === undefined ? undefined : mcpToolOf(toolTitle(ask.toolCallId)));
  if (tool !== undefined) return classifyTool(tool.server, tool.tool, held);
  // A command request without its command line: the title is the best guess, and the gate errs toward asking.
  if (ask.kind === "execute") return classifyCommand(ask.title, held);
  return { kind: "other" };
}

/**
 * The options of a request, without Claude's choices that leave plan mode into auto or bypass mode:
 * in those modes the CLI stops asking, so majhi would no longer see a connection write.
 */
export function withoutUnaskedModes(options: PermissionAsk["options"]): PermissionAsk["options"] {
  return options.filter((o) => !/^exit-plan-(?:clear-)?(?:auto|bypass)$/.test(o.id));
}
