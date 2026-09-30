import { randomBytes } from "node:crypto";
import type { McpServerSpec } from "@majhi/acp";
import type { AgentFrontmatter } from "@majhi/shared";

export const ROOM_SERVER_NAME = "majhi-room";
export const TASKS_SERVER_NAME = "majhi-tasks";
export const ROOM_PATH = "/mcp/room";
export const TASKS_PATH = "/mcp/tasks";
export const PROCESSES_SERVER_NAME = "majhi-processes";
export const PROCESSES_PATH = "/mcp/processes";

export type ToolServer = "room" | "tasks" | "processes";

/** Who a token belongs to: one agent session in one task. */
export interface ToolCaller {
  task: string;
  agent: string;
}

/** Bearer tokens for one MCP server, one per agent session, in memory only. */
export class ToolTokens {
  private readonly tokens = new Map<string, ToolCaller>();

  issue(caller: ToolCaller): string {
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, caller);
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  lookup(token: string): ToolCaller | undefined {
    return this.tokens.get(token);
  }

  get size(): number {
    return this.tokens.size;
  }
}

/**
 * Which sessions get `majhi-room`, `majhi-tasks` and `majhi-processes` (SPEC 5.1, 5.3, 5.4a,
 * 5.15): `majhi-room` for every agent in a team of two or more, or with it in its `tools`;
 * `majhi-tasks` for leads and root agents, or with it in its `tools`. The boss has every command
 * through majhi-admin already. `majhi-processes` for every session.
 */
export class RoomAccess {
  readonly room = new ToolTokens();
  readonly tasks = new ToolTokens();
  readonly processes = new ToolTokens();

  /** `mcpUrl` gives majhi-admin's URL; these servers sit next to it. */
  constructor(private readonly mcpUrl: () => string) {}

  attach(
    caller: ToolCaller,
    agent: Pick<AgentFrontmatter, "id" | "role" | "scope" | "tools">,
    context: { teamSize: number; boss: string | undefined },
  ): { tokens: { server: ToolServer; token: string }[]; servers: McpServerSpec[] } {
    const out: { tokens: { server: ToolServer; token: string }[]; servers: McpServerSpec[] } = {
      tokens: [],
      servers: [],
    };
    const base = this.mcpUrl().replace(/\/mcp$/, "");
    if (context.teamSize > 1 || agent.tools.includes(ROOM_SERVER_NAME)) {
      const token = this.room.issue(caller);
      out.tokens.push({ server: "room", token });
      out.servers.push(spec(ROOM_SERVER_NAME, `${base}${ROOM_PATH}`, token));
    }
    const lead = agent.role === "Lead" || agent.scope === "root";
    if (agent.id !== context.boss && (lead || agent.tools.includes(TASKS_SERVER_NAME))) {
      const token = this.tasks.issue(caller);
      out.tokens.push({ server: "tasks", token });
      out.servers.push(spec(TASKS_SERVER_NAME, `${base}${TASKS_PATH}`, token));
    }
    const token = this.processes.issue(caller);
    out.tokens.push({ server: "processes", token });
    out.servers.push(spec(PROCESSES_SERVER_NAME, `${base}${PROCESSES_PATH}`, token));
    return out;
  }

  revoke(tokens: readonly { server: ToolServer; token: string }[]): void {
    for (const t of tokens) this[t.server].revoke(t.token);
  }
}

function spec(name: string, url: string, token: string): McpServerSpec {
  return { type: "http", name, url, headers: { Authorization: `Bearer ${token}` } };
}
