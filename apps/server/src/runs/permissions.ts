import type { PermissionAsk } from "@majhi/acp";
import { classifyCommand, classifyTool, type GateConnection, type GateVerdict } from "../connections/gate.ts";

/**
 * The parts of an agent's permission request that are read by name. What a request is worth (its risk kind)
 * is decided in `request-risk.ts`; this file reads tool names, the keys a task's "Allow for this task" is
 * kept under and the connection gate's view of a request.
 */

/** majhi's own MCP servers, as a CLI names them in `mcp__<server>__<tool>`. */
const MAJHI_SERVERS: ReadonlySet<string> = new Set([
  "majhi-admin",
  "majhi-decide",
  "majhi-room",
  "majhi-tasks",
  "majhi-memory",
  "majhi-connections",
  "majhi-containers",
]);

/** A call to majhi's background process server, which runs commands. */
export function isProcessTool(title: string): boolean {
  return mcpToolOf(title)?.server === "majhi-processes";
}

/** A call to one of majhi's own MCP servers, as the CLIs name it: `mcp__majhi-admin__<tool>`. */
export function isMajhiTool(title: string): boolean {
  const server = mcpToolOf(title)?.server;
  return server !== undefined && MAJHI_SERVERS.has(server);
}

/** The key an "Allow for this task" on a kind of action is kept under, for one task. */
export function riskAllowKey(kind: string): string {
  return `risk:${kind}`;
}

/**
 * The key an "Allow in this task" on a connection's MCP tool is kept under: that connection and tool in
 * this task only, never a connection write by another tool.
 */
export function connectionToolKey(connection: string, tool: string): string {
  return `connection-tool:${connection}.${tool}`;
}

/** A name of an MCP server or tool: letters, digits, `_`, `-` and, in a tool, `.`. */
function nameChars(text: string, dots: boolean): boolean {
  if (text === "") return false;
  for (const ch of text) {
    const word = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
    if (!word && ch !== "_" && ch !== "-" && !(dots && ch === ".")) return false;
  }
  return true;
}

/** The server and tool of an MCP call: Claude names it `mcp__<server>__<tool>`, Codex `mcp.<server>.<tool>`. */
export function mcpToolOf(title: string | undefined): { server: string; tool: string } | undefined {
  const text = (title ?? "").trim();
  if (text.startsWith("mcp__")) {
    const rest = text.slice("mcp__".length);
    // The server's name ends at the first double underscore after at least one character.
    const cut = rest.indexOf("__", 1);
    if (cut === -1) return undefined;
    const server = rest.slice(0, cut);
    const tool = rest.slice(cut + 2);
    return nameChars(server, false) && nameChars(tool, true) ? { server, tool } : undefined;
  }
  if (text.startsWith("mcp.")) {
    const rest = text.slice("mcp.".length);
    const cut = rest.indexOf(".");
    if (cut < 1) return undefined;
    const server = rest.slice(0, cut);
    const tool = rest.slice(cut + 1);
    return nameChars(server, false) && nameChars(tool, true) ? { server, tool } : undefined;
  }
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
  const unasked = new Set([
    "exit-plan-auto",
    "exit-plan-bypass",
    "exit-plan-clear-auto",
    "exit-plan-clear-bypass",
  ]);
  return options.filter((o) => !unasked.has(o.id));
}
