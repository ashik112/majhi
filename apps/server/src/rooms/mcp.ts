import { type AgentFrontmatter, type CommandName, canWorkIn, commands, parseTaskText } from "@majhi/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { z } from "zod";
import type { AdminService } from "../admin/service.ts";
import { bearerOf } from "../admin/tokens.ts";
import { toolName } from "../admin/tools.ts";
import type { AgentStore } from "../agents/store.ts";
import { errorMessage, formatIssues } from "../errors.ts";
import { isLoopbackOrigin } from "../http/origin.ts";
import type { ProcessManager } from "../processes/manager.ts";
import { processesServer } from "../processes/mcp.ts";
import type { ProjectService } from "../projects/service.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import {
  PROCESSES_PATH,
  PROCESSES_SERVER_NAME,
  ROOM_PATH,
  ROOM_SERVER_NAME,
  type RoomAccess,
  TASKS_PATH,
  TASKS_SERVER_NAME,
  type ToolCaller,
  type ToolTokens,
} from "./access.ts";
import type { RoomCoordinator } from "./coordinator.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

interface Tool {
  name: string;
  description: string;
  input: z.ZodObject;
  /** For majhi-tasks: the command the tool runs. */
  command?: CommandName;
}

// ---------------------------------------------------------------------------
// majhi-room (5.3)

const ROOM_TOOLS: Tool[] = [
  {
    name: "read_recent",
    description:
      "Read the task room: the latest messages, newest first, each cut in the middle when long. Use before_seq to read further back.",
    input: z.object({
      limit: z.number().int().min(1).max(50).default(20),
      before_seq: z.number().int().positive().optional(),
    }),
  },
  {
    name: "post",
    description:
      "Post a message to the room now, as yourself, without ending your turn. It wakes nobody: to hand work on, use mention, or mention the agent in your final reply.",
    input: z.object({ text: z.string().trim().min(1).max(20_000) }),
  },
  {
    name: "mention",
    description:
      "Hand work to a teammate now: it gets your text as its next prompt. Counts toward the room's limit of agent turns without the owner.",
    input: z.object({
      agent: z.string().trim().min(1),
      text: z.string().trim().min(1).max(20_000),
    }),
  },
];

// ---------------------------------------------------------------------------
// majhi-tasks (5.4a, 5.10)

/** Each tool is one command, run under the approval policy like the boss's. */
const TASK_TOOLS: (Tool & { command: CommandName })[] = [
  { name: "list", command: "tasks.list", description: "List the tasks of your org, newest first." },
  { name: "get", command: "tasks.get", description: "Show one task with its repos, team and links." },
  {
    name: "create",
    command: "tasks.create",
    description:
      "Create a task from task box text (what to do, which repos). With parent, it becomes a subtask; with dependsOn, it waits for those tasks. It does not start unless start is true and the owner allows it.",
  },
  {
    name: "split",
    command: "tasks.split",
    description:
      "Split a task into subtasks, in order. A subtask can wait for earlier ones (dependsOn: their positions, from 0). when: ready stacks its branch on the one it waits for.",
  },
  {
    name: "update",
    command: "tasks.update",
    description: "Change a task's title, description or coordination mode.",
  },
  {
    name: "merge",
    command: "tasks.merge",
    description:
      "Merge a task's branch into a local branch in the owner's checkout: its base by default, or the branch the owner names (dev, staging). Never pushes. Only for agents with the Merge permission, once the checks pass.",
  },
  {
    name: "link",
    command: "tasks.link",
    description: "Make a task wait for another (depends-on), or a subtask of another (parent).",
  },
].map((t) => ({
  ...t,
  command: t.command as CommandName,
  input: commands[t.command as CommandName].input as unknown as z.ZodObject,
}));

const ASK_FIELDS = {
  ownerAsked: { type: "boolean", description: "true only if the owner asked for this in the conversation" },
  reason: { type: "string", description: "Why you are calling this, in one plain sentence" },
} as const;

function listed(tools: readonly Tool[], ask: boolean) {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
    const { $schema: _dropped, ...rest } = schema;
    if (!ask)
      return { name: t.name, description: t.description, inputSchema: { ...rest, type: "object" as const } };
    const properties = { ...((rest.properties ?? {}) as Record<string, unknown>), ...ASK_FIELDS };
    const required = [
      ...(Array.isArray(rest.required) ? (rest.required as string[]) : []),
      "ownerAsked",
      "reason",
    ];
    return {
      name: t.name,
      description:
        t.command === undefined ? t.description : `${t.description} Risk: ${commands[t.command].risk}.`,
      inputSchema: { ...rest, type: "object" as const, properties, required },
    };
  });
}

/** At most this many tasks in one `list` answer. */
const LIST_MAX = 100;

export interface RoomMcpDeps {
  tasks: TaskService;
  access: RoomAccess;
  coordinator: RoomCoordinator;
  admin: AdminService;
  room: RoomService;
  store: Store;
  agents: AgentStore;
  projects: ProjectService;
  processes: ProcessManager;
}

/**
 * `/mcp/room`, `/mcp/tasks` and `/mcp/processes`: stateless streamable HTTP like `/mcp`, one bearer token per agent
 * session. `majhi-tasks` runs its commands through the boss's approval policy, and an org agent
 * only sees and changes tasks of the orgs it may work in.
 */
export function roomMcpRoutes(deps: RoomMcpDeps): Hono {
  const app = new Hono();
  app.all(ROOM_PATH, (c) =>
    serve(
      c.req.raw,
      c.req.header("origin"),
      c.req.header("authorization"),
      deps.access.room,
      ROOM_SERVER_NAME,
      (caller) => roomServer(caller, deps),
    ),
  );
  app.all(TASKS_PATH, (c) =>
    serve(
      c.req.raw,
      c.req.header("origin"),
      c.req.header("authorization"),
      deps.access.tasks,
      TASKS_SERVER_NAME,
      (caller) => tasksServer(caller, deps),
    ),
  );
  app.all(PROCESSES_PATH, (c) =>
    serve(
      c.req.raw,
      c.req.header("origin"),
      c.req.header("authorization"),
      deps.access.processes,
      PROCESSES_SERVER_NAME,
      (caller) => processesServer(caller, deps.processes),
    ),
  );
  return app;
}

async function serve(
  request: Request,
  origin: string | undefined,
  authorization: string | undefined,
  tokens: ToolTokens,
  name: string,
  build: (caller: ToolCaller) => Server,
): Promise<Response> {
  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    return Response.json({ error: `${name} is not for web pages` }, { status: 403 });
  }
  const token = bearerOf(authorization);
  const caller = token === undefined ? undefined : tokens.lookup(token);
  if (caller === undefined) {
    return Response.json(
      { error: "A valid bearer token is required" },
      { status: 401, headers: { "www-authenticate": "Bearer" } },
    );
  }
  const server = build(caller);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close().catch(() => undefined);
  }
}

function roomServer(caller: ToolCaller, deps: RoomMcpDeps): Server {
  const server = new Server({ name: ROOM_SERVER_NAME, version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed(ROOM_TOOLS, false) }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<Result> => {
    const tool = ROOM_TOOLS.find((t) => t.name === request.params.name);
    if (tool === undefined) return fail(`There is no tool ${request.params.name}.`);
    const parsed = tool.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return fail(`Invalid arguments:\n${formatIssues(parsed.error).join("\n")}`);
    const args = parsed.data as Record<string, unknown>;
    try {
      switch (tool.name) {
        case "read_recent":
          return ok(
            deps.coordinator.readRecent(
              caller.task,
              args.limit as number,
              args.before_seq as number | undefined,
            ),
          );
        case "post": {
          const id = `agent:tool:${crypto.randomUUID()}`;
          deps.room.post(caller.task as never, id, {
            type: "agent",
            agent: caller.agent,
            text: args.text as string,
          });
          return ok("Posted.");
        }
        case "mention":
          return ok(
            await deps.coordinator.mention(
              caller,
              String(args.agent).replace(/^@/, "").toLowerCase(),
              args.text as string,
            ),
          );
      }
      return fail(`There is no tool ${tool.name}.`);
    } catch (err) {
      return fail(errorMessage(err));
    }
  });
  return server;
}

function tasksServer(caller: ToolCaller, deps: RoomMcpDeps): Server {
  const server = new Server({ name: TASKS_SERVER_NAME, version: "1" }, { capabilities: { tools: {} } });
  // The merge tool is offered only to agents with the Merge permission.
  const mayMerge = async () =>
    (await frontmatter(deps.agents, caller.agent))?.perms.includes("merge") === true;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listed(
      (await mayMerge()) ? TASK_TOOLS : TASK_TOOLS.filter((t) => t.command !== "tasks.merge"),
      true,
    ),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<Result> => {
    const tool = TASK_TOOLS.find((t) => t.name === request.params.name);
    if (tool === undefined) return fail(`There is no tool ${request.params.name}.`);
    const args = { ...(request.params.arguments ?? {}) } as Record<string, unknown>;
    try {
      const fm = await frontmatter(deps.agents, caller.agent);
      if (fm === undefined) return fail(`@${caller.agent} is not a valid agent any more.`);
      if (tool.command === "tasks.merge" && !fm.perms.includes("merge")) {
        return fail(
          "You do not have the Merge permission. Say in the room that the branch is ready to merge.",
        );
      }
      const refused = await refuseOutsideOrg(deps, fm, tool.command, args);
      if (refused !== undefined) return fail(refused);
      if (tool.command === "tasks.list") {
        // A read, so no card. An org agent sees only the tasks of orgs it may work in.
        const rows = deps.tasks
          .list(args.includeDone === true)
          .filter((t) => fm.scope === "root" || canWorkIn(fm, t.org))
          .slice(0, LIST_MAX)
          .map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            org: t.org,
            team: t.team,
            waitingOn: t.waitingOn,
          }));
        return ok(JSON.stringify(rows, null, 2));
      }
      const result = await deps.admin.call(caller, toolName(tool.command), args);
      return result.isError ? fail(result.text) : ok(result.text);
    } catch (err) {
      return fail(errorMessage(err));
    }
  });
  return server;
}

async function frontmatter(agents: AgentStore, id: string): Promise<AgentFrontmatter | undefined> {
  const stored = await agents.get(id);
  return stored?.ok ? stored.agent.frontmatter : undefined;
}

/**
 * Why an org agent may not run this, or undefined. Tasks it names must be in an org it may work
 * in, and a new task's repos must be too. Root agents may work anywhere.
 */
async function refuseOutsideOrg(
  deps: RoomMcpDeps,
  fm: AgentFrontmatter,
  command: CommandName,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  if (fm.scope === "root") return undefined;
  const ids = [
    args.id,
    args.task,
    args.target,
    args.parent,
    ...(Array.isArray(args.dependsOn) ? args.dependsOn : []),
  ];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const task = deps.store.tasks.get(id);
    if (task !== undefined && !canWorkIn(fm, task.org)) return `${id} is not in an org @${fm.id} works in.`;
  }
  const texts =
    command === "tasks.create"
      ? [args.text]
      : command === "tasks.split" && Array.isArray(args.children)
        ? args.children.map((c) =>
            typeof c === "object" && c !== null ? (c as { text?: unknown }).text : undefined,
          )
        : [];
  const projects = await deps.projects.infos();
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const parsed = parseTaskText(text, {
      projects: projects.map((p) => ({ id: p.id, org: p.org, aliases: p.aliases })),
      agents: [],
    });
    const parentId = command === "tasks.split" ? args.task : args.parent;
    const parent = typeof parentId === "string" ? deps.store.tasks.get(parentId)?.org : undefined;
    const org = parsed.org ?? (parsed.repos.length === 0 ? parent : undefined);
    if (parsed.repos.length > 0 && parsed.org === undefined) return "Those repos are in more than one org.";
    if (
      org === undefined &&
      parsed.repos.length === 0 &&
      command === "tasks.create" &&
      parent === undefined
    ) {
      return `Name a repo of your org, or give a parent task: @${fm.id} cannot create a task without an org.`;
    }
    if (org !== undefined && !canWorkIn(fm, org)) return `@${fm.id} cannot create tasks in "${org}".`;
  }
  return undefined;
}
