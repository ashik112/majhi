import { randomBytes } from "node:crypto";

/** Who a majhi-admin token belongs to: one agent session in one task. */
export interface AdminCaller {
  task: string;
  agent: string;
}

/**
 * Bearer tokens for the majhi-admin MCP server. The run manager issues one when it starts a
 * session for an agent that gets admin tools and revokes it when the session ends. Tokens live in
 * memory only, so a restart ends them all together with the sessions.
 */
export class AdminTokens {
  private readonly tokens = new Map<string, AdminCaller>();
  /** Where agent processes reach the server. `main.ts` sets the real port once it is listening. */
  mcpUrl: string;

  constructor(mcpUrl: string) {
    this.mcpUrl = mcpUrl;
  }

  issue(caller: AdminCaller): string {
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, caller);
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  lookup(token: string): AdminCaller | undefined {
    return this.tokens.get(token);
  }

  /** Live tokens. For tests. */
  get size(): number {
    return this.tokens.size;
  }
}

/** The token in an `Authorization: Bearer <token>` header, or undefined. */
export function bearerOf(header: string | undefined): string | undefined {
  const match = /^Bearer +(\S+)$/i.exec(header ?? "");
  return match?.[1];
}
