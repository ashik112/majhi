import { type ConnectionView, type ConnectStatus, GLOBAL_CONNECTIONS, type Skill } from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";
import { plural } from "@/lib/format";
import type { AgentChoice } from "./parts";

export type ItemKind = "skill" | "mcp";

/** What a row can do in one click. `fix` and `sign-in` open the place that repairs it. */
export type RowAction = "enable-all" | "retry" | "fix" | "sign-in" | "test";

/** One skill or MCP server as a row of the page: the same shape for both, so one row draws both. */
export interface Item {
  /** `skill:<name>` or `mcp:<connection id>`. */
  key: string;
  kind: ItemKind;
  name: string;
  description: string;
  /** `GLOBAL_CONNECTIONS` or a workspace id. */
  scope: string;
  /** The agents that have it now. */
  on: readonly string[];
  /** The agents that could have it. */
  reach: number;
  lamp: LampState;
  /** One line for the lamp: what is wrong, or that it is fine. */
  status: string;
  /** Problem rows show the status in the lamp's color. */
  bad: boolean;
  action: { id: RowAction; label: string } | undefined;
  /** What the owner types to find it. */
  haystack: string;
}

export function skillItem(
  skill: Skill,
  agents: readonly AgentChoice[],
  state: { updating: boolean; failed?: string | undefined },
): Item {
  const on = skill.agents;
  const reach = agents.length;
  const partial = on.length < reach;
  let lamp: LampState = on.length === 0 ? "idle" : "done";
  let status = on.length === 0 ? "Off for every agent" : "Ready";
  let bad = false;
  let action: Item["action"] =
    partial && !skill.defaultOn && reach > 0 ? { id: "enable-all", label: "Enable for all" } : undefined;
  if (state.updating) {
    lamp = "working";
    status = "Checking for a newer copy";
  } else if (state.failed !== undefined) {
    lamp = "needs";
    status = `Update check failed: ${state.failed}`;
    bad = true;
    action = { id: "retry", label: "Retry" };
  }
  return {
    key: `skill:${skill.name}`,
    kind: "skill",
    name: skill.name,
    description: skill.description,
    scope: GLOBAL_CONNECTIONS,
    on,
    reach,
    lamp,
    status,
    bad,
    action,
    haystack: `${skill.name} ${skill.description} ${skill.source}`.toLowerCase(),
  };
}

/** The first line of a long reason, so a row stays one line. */
function firstLine(text: string): string {
  return (text.split("\n")[0] ?? text).trim();
}

export function mcpItem(
  server: ConnectionView,
  status: ConnectStatus | undefined,
  state: { testing: boolean },
): Item {
  const tools = server.lastTest?.tools?.length;
  const reach = server.agents.length + server.agentsOff.length;
  let lamp: LampState = "done";
  let text = tools === undefined ? "Connected" : `Connected, ${plural(tools, "tool")}`;
  let bad = false;
  let action: Item["action"];
  const problem = server.problems[0];
  if (state.testing) {
    lamp = "working";
    text = "Testing";
  } else if (problem !== undefined) {
    lamp = "needs";
    text = `Not set up: ${firstLine(problem)}`;
    bad = true;
    action = { id: "fix", label: "Fix" };
  } else if (status !== undefined && status.state !== "connected") {
    lamp = "needs";
    text = status.state === "error" ? `Sign-in error: ${firstLine(status.reason)}` : "Needs sign-in";
    bad = true;
    action = { id: "sign-in", label: "Sign in" };
  } else if (server.lastTest?.ok === false) {
    lamp = "needs";
    text = `Test failed: ${firstLine(server.lastTest.detail)}`;
    bad = true;
    action = { id: "fix", label: "Fix" };
  } else if (server.lastTest === undefined) {
    lamp = "idle";
    text = "Not tested yet";
    action = { id: "test", label: "Test" };
  }
  return {
    key: `mcp:${server.id}`,
    kind: "mcp",
    name: server.name,
    description: server.description || server.fields.url?.value || server.fields.command?.value || server.id,
    scope: server.org,
    on: server.agents,
    reach,
    lamp,
    status: text,
    bad,
    action,
    haystack: `${server.name} ${server.description} ${server.id}`.toLowerCase(),
  };
}

/** Problems first, then by name, so what needs the owner is at the top. */
export function sortItems(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => Number(b.bad) - Number(a.bad) || a.name.localeCompare(b.name));
}

export function matches(item: Item, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || item.haystack.includes(q);
}

/** The agents a server can reach, grouped as the toggles show them: workspace by workspace. */
export function groupAgents(agents: readonly AgentChoice[]): { scope: string; agents: AgentChoice[] }[] {
  const by = new Map<string, AgentChoice[]>();
  for (const a of agents) by.set(a.scope, [...(by.get(a.scope) ?? []), a]);
  return [...by.entries()]
    .sort(([a], [b]) => (a === "root" ? -1 : b === "root" ? 1 : a.localeCompare(b)))
    .map(([scope, list]) => ({ scope, agents: list }));
}
