import { randomBytes } from "node:crypto";
import type { McpServerSpec } from "@majhi/acp";

export const ROOM_SERVER_NAME = "majhi-room";
export const TASKS_SERVER_NAME = "majhi-tasks";
export const ROOM_PATH = "/mcp/room";
export const TASKS_PATH = "/mcp/tasks";
export const PROCESSES_SERVER_NAME = "majhi-processes";
export const PROCESSES_PATH = "/mcp/processes";

export const CONTAINERS_SERVER_NAME = "majhi-containers";
export const CONTAINERS_PATH = "/mcp/containers";

/** The `docker` shim of a runner calls this (`docker/docker-shim.mjs`). Not an MCP server: a plain POST. */
export const DOCKER_PATH = "/mcp/docker";

export const MEMORY_SERVER_NAME = "majhi-memory";
export const MEMORY_PATH = "/mcp/memory";

export const CONNECTIONS_SERVER_NAME = "majhi-connections";
export const CONNECTIONS_PATH = "/mcp/connections";

export type ToolServer = "room" | "tasks" | "processes" | "memory" | "containers" | "connections" | "docker";

/** The servers RoomAccess issues, in the order a session lists them. */
const SERVERS: readonly { key: ToolServer; name: string; path: string }[] = [
  { key: "room", name: ROOM_SERVER_NAME, path: ROOM_PATH },
  { key: "tasks", name: TASKS_SERVER_NAME, path: TASKS_PATH },
  { key: "processes", name: PROCESSES_SERVER_NAME, path: PROCESSES_PATH },
  { key: "containers", name: CONTAINERS_SERVER_NAME, path: CONTAINERS_PATH },
  { key: "memory", name: MEMORY_SERVER_NAME, path: MEMORY_PATH },
  { key: "connections", name: CONNECTIONS_SERVER_NAME, path: CONNECTIONS_PATH },
];

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
 * Tokens and server entries for the majhi MCP servers next to majhi-admin: room, tasks, processes,
 * memory and containers (SPEC 5.1, 5.3, 5.4a, 5.15). Which ones a session gets is decided in one
 * place, `gateTools` (`./gating.ts`); this issues what it was told to.
 */
export class RoomAccess {
  readonly room = new ToolTokens();
  readonly tasks = new ToolTokens();
  readonly processes = new ToolTokens();
  readonly memory = new ToolTokens();
  readonly containers = new ToolTokens();
  readonly connections = new ToolTokens();
  /** Tokens of the `docker` shim: one per run, one per hand-off check. They only reach the caller's own task. */
  readonly docker = new ToolTokens();

  /**
   * `mcpUrl` gives majhi-admin's URL; these servers sit next to it. `containersOn` says whether majhi
   * can run containers (PRV-53): only then do sessions get `majhi-containers`.
   */
  constructor(
    private readonly mcpUrl: () => string,
    private readonly containersOn: () => boolean = () => false,
  ) {}

  /** Whether majhi can run containers now. */
  get canRunContainers(): boolean {
    return this.containersOn();
  }

  /** A token and an entry for each of `wanted` (server names like `majhi-room`); other names are not ours. */
  attach(
    caller: ToolCaller,
    wanted: readonly string[],
  ): { tokens: { server: ToolServer; token: string }[]; servers: McpServerSpec[] } {
    const out: { tokens: { server: ToolServer; token: string }[]; servers: McpServerSpec[] } = {
      tokens: [],
      servers: [],
    };
    const base = this.mcpUrl().replace(/\/mcp$/, "");
    for (const server of SERVERS) {
      if (!wanted.includes(server.name)) continue;
      const token = this[server.key].issue(caller);
      out.tokens.push({ server: server.key, token });
      out.servers.push(spec(server.name, `${base}${server.path}`, token));
    }
    return out;
  }

  /**
   * What a run needs for its scripts' `docker` to work: a token for `/mcp/docker` and the two
   * variables the shim reads. Absent when majhi cannot run containers. Revoke `entry` with the
   * session's other tokens.
   */
  attachDocker(
    caller: ToolCaller,
  ): { entry: { server: "docker"; token: string }; env: Record<string, string> } | undefined {
    if (!this.containersOn()) return undefined;
    const token = this.docker.issue(caller);
    const base = this.mcpUrl().replace(/\/mcp$/, "");
    return {
      entry: { server: "docker", token },
      env: { MAJHI_DOCKER_URL: `${base}${DOCKER_PATH}`, MAJHI_DOCKER_TOKEN: token },
    };
  }

  revoke(tokens: readonly { server: ToolServer; token: string }[]): void {
    for (const t of tokens) this[t.server].revoke(t.token);
  }
}

function spec(name: string, url: string, token: string): McpServerSpec {
  return { type: "http", name, url, headers: { Authorization: `Bearer ${token}` } };
}
