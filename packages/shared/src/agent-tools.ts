import { z } from "zod";

/**
 * An entry of an agent file's `tools`: a server name, or a server name with a leading dash that
 * turns its default off (`-majhi-decide`). SPEC 5.9 item 5.
 */
export const AgentToolRefSchema = z
  .string()
  .trim()
  .regex(
    /^-?[a-z0-9][a-z0-9-]{0,62}$/,
    "Use a tool name like serena, or -majhi-decide to turn a default off",
  );

/** The MCP servers majhi attaches to a session, with the rule that decides each one. */
export const TOOL_CATALOG = [
  {
    name: "majhi-decide",
    summary: "Quick typed judgment calls from the decision model instead of reasoning tokens",
    rule: "Off unless the agent lists it. No agent called it in five days, and its schema costs context in every session",
  },
  {
    name: "majhi-processes",
    summary: "Run long commands and servers so majhi wakes the agent when they end",
    rule: "On for every agent",
  },
  {
    name: "majhi-memory",
    summary: "Recall and propose lessons from earlier tasks",
    rule: "On for every agent",
  },
  {
    name: "majhi-room",
    summary: "Read the room, post, mention a teammate, ask the owner, draw a diagram for the owner",
    rule: "On in a team of two or more, and for a lone lead; in a chat only the drawing tools; add it to any other agent",
  },
  {
    name: "majhi-tasks",
    summary: "Create, plan and start tasks",
    rule: "On for leads and root agents; add it to any other agent",
  },
  {
    name: "majhi-containers",
    summary: "Build previews and run services in containers",
    rule: "On for every agent when majhi can run containers",
  },
  {
    name: "serena",
    summary: "Symbol-level code reads and edits instead of whole files",
    rule: "On for builders in a task with a worktree, when the runner can start it; add it to any other agent",
  },
  {
    name: "majhi-connections",
    summary: "List the run's connections, attach one to the task, run commands over SSH through the gate",
    rule: "On for every session that holds a connection, and for root agents",
  },
  {
    name: "majhi-skills",
    summary: "Look up the skills turned on for the run, only when the work needs one",
    rule: "On for a session whose CLI does not list skills itself (not Claude Code in a runner) and that has skills",
  },
  {
    name: "majhi-admin",
    summary: "Every majhi command, with the owner's approval policy",
    rule: "The captain, and root agents that list it. The captain keeps it",
  },
] as const satisfies readonly { name: string; summary: string; rule: string }[];

export type CatalogTool = (typeof TOOL_CATALOG)[number]["name"];

/** What an agent file says about one server: nothing (the role decides), listed, or turned off. */
export type ToolSetting = "default" | "added" | "off";

export function toolSetting(tools: readonly string[], name: string): ToolSetting {
  if (tools.includes(`-${name}`)) return "off";
  return tools.includes(name) ? "added" : "default";
}

/** The `tools` list with one server's setting changed; everything else stays as it was. */
export function withToolSetting(tools: readonly string[], name: string, setting: ToolSetting): string[] {
  const rest = tools.filter((t) => t !== name && t !== `-${name}`);
  if (setting === "added") return [...rest, name];
  if (setting === "off") return [...rest, `-${name}`];
  return rest;
}

/** The servers a run attached, as recorded on the run (`runs.tools`). */
export const AttachedToolsSchema = z.object({
  agent: z.string(),
  task: z.string(),
  at: z.string(),
  tools: z.array(z.string()),
});
export type AttachedTools = z.infer<typeof AttachedToolsSchema>;
