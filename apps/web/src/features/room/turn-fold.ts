import type { RoomItem } from "@majhi/shared";
import { oneLine } from "./model";

type ToolItem = Extract<RoomItem, { type: "tool" }>;

/**
 * What an agent did between two messages, as one line: how many steps, the commands it ran, the tools it
 * called by server, the files it read or changed, and how many its rules allowed. Typed fields only: the
 * kind of a tool call, its server and its name; no reading of messages.
 */
export interface StepsSummary {
  /** Tool calls and thoughts. */
  steps: number;
  text: string;
}

/** The server and tool of an MCP call (`mcp__majhi-tasks__get`), or undefined for any other call. */
export function mcpCall(title: string): { server: string; tool: string } | undefined {
  const t = title.trim();
  if (!t.startsWith("mcp__")) return undefined;
  const rest = t.slice("mcp__".length);
  const at = rest.indexOf("__");
  if (at <= 0) return undefined;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2).replaceAll("_", " ") };
}

/** A command as one short run of text, for the summary line. */
function command(item: ToolItem): string {
  return oneLine(item.title, 28);
}

/** The words of `n` things of a kind: "read 4 files", "edited 1 file". */
function count(n: number, verb: string, noun: string): string {
  return `${verb} ${n} ${n === 1 ? noun : `${noun}s`}`;
}

export function summarizeSteps(items: readonly RoomItem[]): StepsSummary {
  const tools = items.filter((i): i is ToolItem => i.type === "tool");
  const thoughts = items.filter((i) => i.type === "thought").length;
  const rules = items.filter(
    (i) => (i.type === "permission" && i.state === "auto") || (i.type === "approval" && i.alone === true),
  ).length;
  const parts: string[] = [];

  const ran = tools.filter((t) => t.kind === "execute" && mcpCall(t.title) === undefined);
  const first = ran[0];
  if (first !== undefined) {
    const more = ran.length - 1;
    parts.push(`ran \`${command(first)}\`${more > 0 ? ` +${more}` : ""}`);
  }

  // Tools of one server read as "server: a, b"; a second server follows.
  const servers = new Map<string, string[]>();
  for (const t of tools) {
    const call = mcpCall(t.title);
    if (call === undefined) continue;
    const list = servers.get(call.server) ?? [];
    if (!list.includes(call.tool)) list.push(call.tool);
    servers.set(call.server, list);
  }
  for (const [server, list] of servers) parts.push(`${server}: ${list.join(", ")}`);

  const files = (kind: string) =>
    new Set(tools.filter((t) => t.kind === kind).map((t) => t.locations[0] ?? t.id)).size;
  const read = files("read");
  if (read > 0) parts.push(count(read, "read", "file"));
  const edited = files("edit");
  if (edited > 0) parts.push(count(edited, "edited", "file"));
  const searched = tools.filter((t) => t.kind === "search").length;
  if (searched > 0) parts.push(`searched ${searched} ${searched === 1 ? "time" : "times"}`);

  if (rules > 0) parts.push(`${rules} allowed by rule`);
  const steps = tools.length + thoughts;
  return { steps, text: [`${steps} ${steps === 1 ? "step" : "steps"}`, ...parts].join(" · ") };
}
