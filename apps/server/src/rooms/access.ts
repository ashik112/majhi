import { randomBytes } from "node:crypto";
import type { McpServerSpec } from "@majhi/acp";
import type { AgentFrontmatter } from "@majhi/shared";

export const ROOM_SERVER_NAME = "majhi-room";
export const TASKS_SERVER_NAME = "majhi-tasks";
export const ROOM_PATH = "/mcp/room";
export const TASKS_PATH = "/mcp/tasks";

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
 * Which sessions get `majhi-room` and `majhi-tasks` (SPEC 5.1, 5.3, 5.4a): `majhi-room` for every
 * agent in a team of two or more, or with it in its `tools`; `majhi-tasks` for leads and root
 * agents, or with it in its `tools`. The boss has every command through majhi-admin already.
 */
export class RoomAccess {
  readonly room = new ToolTokens();
  readonly tasks = new ToolTokens();

  /** `mcpUrl` gives majhi-admin's URL; these servers sit next to it. */
  constructor(private readonly mcpUrl: () => string) {}

  attach(
    caller: ToolCaller,
    agent: Pick<AgentFrontmatter, "id" | "role" | "scope" | "tools">,
    context: { teamSize: number; boss: string | undefined },
  ): { tokens: { server: "room" | "tasks"; token: string }[]; servers: McpServerSpec[] } {
    const out: { tokens: { server: "room" | "tasks"; token: string }[]; servers: McpServerSpec[] } = {
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
    return out;
  }

  revoke(tokens: readonly { server: "room" | "tasks"; token: string }[]): void {
    for (const t of tokens) (t.server === "room" ? this.room : this.tasks).revoke(t.token);
  }
}

function spec(name: string, url: string, token: string): McpServerSpec {
  return { type: "http", name, url, headers: { Authorization: `Bearer ${token}` } };
}
