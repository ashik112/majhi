import { randomBytes } from "node:crypto";
import type { McpServerSpec } from "@majhi/acp";
import type { Decider } from "./session-decision.ts";

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

/** The Codex hook of a runner (`docker/codex/hook.mjs`) asks here before every tool call. Not an MCP server: a plain POST. */
export const CODEX_HOOK_PATH = "/mcp/codex-hook";

/**
 * A repo's own `playwright test` connects here (`PW_TEST_CONNECT_WS_ENDPOINT`) with the run's token. A WebSocket
 * upgrade, handled in `sockets.ts`, not an MCP server.
 */
export const TEST_BROWSER_PATH = "/mcp/testbrowser";

export const MEMORY_SERVER_NAME = "majhi-memory";
export const MEMORY_PATH = "/mcp/memory";

export const SKILLS_SERVER_NAME = "majhi-skills";
export const SKILLS_PATH = "/mcp/skills";

export const CONNECTIONS_SERVER_NAME = "majhi-connections";
export const CONNECTIONS_PATH = "/mcp/connections";

/** `read`, `list` and `search` over the folders of one read-only session, for agents that have no read tool of their own. */
export const FILES_SERVER_NAME = "majhi-files";
export const FILES_PATH = "/mcp/files";

export type ToolServer =
  | "room"
  | "tasks"
  | "processes"
  | "memory"
  | "containers"
  | "connections"
  | "skills"
  | "docker"
  | "codexHook"
  | "files"
  | "testBrowser";

/** The servers `attach` issues for a run's caller, in the order a session lists them. */
type RunServer = Exclude<ToolServer, "docker" | "codexHook" | "files" | "testBrowser">;
const SERVERS: readonly { key: RunServer; name: string; path: string }[] = [
  { key: "room", name: ROOM_SERVER_NAME, path: ROOM_PATH },
  { key: "tasks", name: TASKS_SERVER_NAME, path: TASKS_PATH },
  { key: "processes", name: PROCESSES_SERVER_NAME, path: PROCESSES_PATH },
  { key: "containers", name: CONTAINERS_SERVER_NAME, path: CONTAINERS_PATH },
  { key: "memory", name: MEMORY_SERVER_NAME, path: MEMORY_PATH },
  { key: "connections", name: CONNECTIONS_SERVER_NAME, path: CONNECTIONS_PATH },
  { key: "skills", name: SKILLS_SERVER_NAME, path: SKILLS_PATH },
];

/** Who a token belongs to: one agent session in one task. */
export interface ToolCaller {
  task: string;
  agent: string;
}

/** The folders one `files` token reads: the session's own folder and the other folders it may read. */
export interface FilesScope {
  root: string;
  also: readonly string[];
}

/**
 * A session that has no run: it decides its own tool calls. A Codex session of the Housekeeper or of the decision
 * stand-in holds one, and `servers` are the majhi servers it was given (the names the hook sees as `mcp__...`).
 */
export interface HookSession {
  decide: Decider;
  servers: readonly string[];
}

/** What a hook token is bound to: a run, whose calls go through the permission flow, or a session's own rule. */
export type HookBinding = { kind: "run"; caller: ToolCaller } | { kind: "session"; session: HookSession };

/** Bearer tokens for one MCP server, one per agent session, in memory only. */
export class ToolTokens<T = ToolCaller> {
  private readonly tokens = new Map<string, T>();

  issue(holder: T): string {
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, holder);
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  lookup(token: string): T | undefined {
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
  readonly skills = new ToolTokens();
  /** Tokens of the `docker` shim: one per run, one per hand-off check. They only reach the caller's own task. */
  readonly docker = new ToolTokens();
  /**
   * Tokens of Codex's PreToolUse hook: one per Codex session. A token only asks about its own run (task and agent),
   * or is answered by its own session's rule.
   */
  readonly codexHook = new ToolTokens<HookBinding>();
  /** Tokens of `majhi-files`: one per read-only session. A token reads only its own session's folders. */
  readonly files = new ToolTokens<FilesScope>();
  /** Tokens for the test browser's WebSocket: one per run. They only reach the caller's own workspace. */
  readonly testBrowser = new ToolTokens();

  /**
   * `mcpUrl` gives majhi-admin's URL; these servers sit next to it. `containersOn` says whether majhi
   * can run containers (PRV-53): only then do sessions get `majhi-containers`.
   */
  constructor(
    private readonly mcpUrl: () => string,
    private readonly containersOn: () => boolean = () => false,
    private readonly testBrowserOn: () => boolean = () => false,
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

  /**
   * What a Codex session needs for its PreToolUse hook: where to ask and the session's token, as the two variables
   * the hook script reads. Revoke `entry` with the session's other tokens, so a token never outlives its run.
   */
  attachCodexHook(caller: ToolCaller): {
    entry: { server: "codexHook"; token: string };
    env: Record<string, string>;
  } {
    return this.hookFor({ kind: "run", caller });
  }

  /**
   * The same for a Codex session that has no run (the Housekeeper's, the stand-in's): its calls are judged by the
   * session's own rule. Revoke `entry` when the session ends.
   */
  attachCodexSession(session: HookSession): {
    entry: { server: "codexHook"; token: string };
    env: Record<string, string>;
  } {
    return this.hookFor({ kind: "session", session });
  }

  private hookFor(binding: HookBinding): {
    entry: { server: "codexHook"; token: string };
    env: Record<string, string>;
  } {
    const token = this.codexHook.issue(binding);
    const base = this.mcpUrl().replace(/\/mcp$/, "");
    return {
      entry: { server: "codexHook", token },
      env: { MAJHI_HOOK_URL: `${base}${CODEX_HOOK_PATH}`, MAJHI_HOOK_TOKEN: token },
    };
  }

  /**
   * What a session with no run needs when its agent is Codex: `majhi-files` over `files` (a repo's export, read-only,
   * for an agent with no read tool of its own), and, when `hook` (the session runs in a runner, where Codex has
   * no sandbox of its own), the hook variables, so every tool call is judged by `decide`. `revoke` ends both tokens.
   */
  attachSession(session: { decide: Decider; files?: FilesScope | undefined; hook: boolean }): {
    servers: McpServerSpec[];
    env: Record<string, string>;
    revoke(): void;
  } {
    const files = session.files === undefined ? undefined : this.attachFiles(session.files);
    const hook = session.hook
      ? this.attachCodexSession({
          decide: session.decide,
          servers: files === undefined ? [] : [FILES_SERVER_NAME],
        })
      : undefined;
    return {
      servers: files === undefined ? [] : [files.server],
      env: hook?.env ?? {},
      revoke: () =>
        this.revoke([
          ...(files === undefined ? [] : [files.entry]),
          ...(hook === undefined ? [] : [hook.entry]),
        ]),
    };
  }

  /**
   * `majhi-files` for a read-only session: the server entry (its token in a header, which the session keeps off
   * command lines) and the entry to revoke when the session ends.
   */
  attachFiles(scope: FilesScope): { entry: { server: "files"; token: string }; server: McpServerSpec } {
    const token = this.files.issue(scope);
    const base = this.mcpUrl().replace(/\/mcp$/, "");
    return {
      entry: { server: "files", token },
      server: spec(FILES_SERVER_NAME, `${base}${FILES_PATH}`, token),
    };
  }

  /**
   * What a run needs for its repo's `playwright test` to get a browser: where to connect, the run's token, and the
   * switch that lets the remote browser reach the run's own localhost (the app under test). Absent when majhi has
   * no test browser. Revoke `entry` with the session's other tokens.
   */
  attachTestBrowser(
    caller: ToolCaller,
  ): { entry: { server: "testBrowser"; token: string }; env: Record<string, string> } | undefined {
    if (!this.testBrowserOn()) return undefined;
    const token = this.testBrowser.issue(caller);
    const url = new URL(this.mcpUrl());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = TEST_BROWSER_PATH;
    return {
      entry: { server: "testBrowser", token },
      env: {
        PW_TEST_CONNECT_WS_ENDPOINT: url.toString(),
        PW_TEST_CONNECT_HEADERS: JSON.stringify({ Authorization: `Bearer ${token}` }),
        PW_TEST_CONNECT_EXPOSE_NETWORK: "<loopback>",
      },
    };
  }

  revoke(tokens: readonly { server: ToolServer; token: string }[]): void {
    for (const t of tokens) this[t.server].revoke(t.token);
  }
}

function spec(name: string, url: string, token: string): McpServerSpec {
  return { type: "http", name, url, headers: { Authorization: `Bearer ${token}` } };
}
