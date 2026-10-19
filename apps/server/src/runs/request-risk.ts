import type { PermissionAsk } from "@majhi/acp";
import { heaviest, type RiskKind, toolKindRisk } from "@majhi/shared";
import { insideRoots } from "../connections/read-only.ts";
import { isMajhiTool, isProcessTool, mcpToolOf } from "./permissions.ts";
import { type RiskScope, shellRisk } from "./shell-risk.ts";

/**
 * The risk kind of one ACP permission request (docs/briefs/workflow-reset.md, step 1b), from the typed parts of
 * the request: its tool kind, the files it names, the MCP server and tool, and, for a command, its parsed
 * words. Nothing reads the title as prose. A lookup, with no query of its own.
 */

/** The files a write names that lie outside the task, or a key the task has no business with. */
function writeRisk(locations: readonly string[], scope: RiskScope): RiskKind {
  const kinds: RiskKind[] = [];
  for (const path of locations) {
    if (insideRoots(path, scope)) continue;
    kinds.push(shellRisk(`cat ${quote(path)}`, scope) === "secret" ? "secret" : "delete-outside");
  }
  return heaviest(kinds);
}

/** One word for the shell reader, so a path with spaces or a quote stays one word. */
function quote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

export function requestRisk(ask: PermissionAsk, scope: RiskScope): RiskKind {
  // majhi's own tools are gated where they run, by the level (`AdminService`), so the CLI's prompt adds nothing.
  if (isMajhiTool(ask.title) || isProcessTool(ask.title)) return "sandbox";
  switch (toolKindRisk(ask.kind)) {
    case "reads":
      return "sandbox";
    case "writes":
      return writeRisk(ask.locations ?? [], scope);
    case "execute":
      return shellRisk(ask.command ?? ask.title, scope);
    case "unknown":
      // A tool of an MCP server the owner attached to the agent works inside the task; anything else is not ours to judge.
      return mcpToolOf(ask.title) === undefined ? "other" : "sandbox";
  }
}
