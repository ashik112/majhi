import type { McpServerSpec } from "@majhi/acp";
import type { AdminCaller, AdminTokens } from "./tokens.ts";

export const ADMIN_TOOL_ID = "majhi-admin";
export const ADMIN_SERVER_NAME = "majhi-admin";

/** True for the captain, and for any root agent whose `tools` list has `majhi-admin`. */
export function getsAdminTools(
  agent: { id: string; scope: string; tools: readonly string[] },
  boss: string | undefined,
): boolean {
  return agent.id === boss || (agent.scope === "root" && agent.tools.includes(ADMIN_TOOL_ID));
}

/** What the run manager uses to give a session the majhi-admin MCP server, and take it back. */
export class AdminAccess {
  constructor(readonly tokens: AdminTokens) {}

  /** A token and the MCP server entry for a session of this agent, or undefined when it gets no admin tools. */
  attach(
    caller: AdminCaller,
    agent: { id: string; scope: string; tools: readonly string[] },
    boss: string | undefined,
  ): { token: string; server: McpServerSpec } | undefined {
    if (!getsAdminTools(agent, boss)) return undefined;
    const token = this.tokens.issue(caller);
    return {
      token,
      server: {
        type: "http",
        name: ADMIN_SERVER_NAME,
        url: this.tokens.mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    };
  }

  revoke(token: string): void {
    this.tokens.revoke(token);
  }
}
