import {
  type AgentFrontmatter,
  type CommandName,
  canWorkIn,
  commands,
  DEFAULT_LEAD_START,
  type DiagramSpec,
  DiagramSpecSchema,
  type JourneyView,
  type ProjectMap,
  ShowMapInputSchema,
  TaskDockerRequestSchema,
  type TeamPlan,
  TeamPlanSchema,
} from "@majhi/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { z } from "zod";
import type { AdminService } from "../admin/service.ts";
import { bearerOf } from "../admin/tokens.ts";
import { OWNER_ONLY_INPUTS, toolName } from "../admin/tools.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { type ConnectionsMcpDeps, connectionsServer } from "../connections/mcp.ts";
import { type ContainersMcpDeps, containersServer } from "../containers/mcp.ts";
import { errorMessage, formatIssues } from "../errors.ts";
import { isLoopbackOrigin } from "../http/origin.ts";
import {
  CODE_GRAPH_DESCRIPTION,
  type CodeGraphInput,
  CodeGraphInputSchema,
  type CodeGraphTools,
} from "../map/graph/tools.ts";
import { type MemoryMcpDeps, memoryServer } from "../memory/mcp.ts";
import type { ProcessManager } from "../processes/manager.ts";
import { processesServer } from "../processes/mcp.ts";
import type { ProjectService } from "../projects/service.ts";
import type { RoomService } from "../room/service.ts";
import { type SkillsMcpDeps, skillsServer } from "../skills/mcp.ts";
import type { Store } from "../store/index.ts";
import { leadMayStart } from "../tasks/lead-start.ts";
import type { TaskService } from "../tasks/service.ts";
import {
  CONNECTIONS_PATH,
  CONNECTIONS_SERVER_NAME,
  CONTAINERS_PATH,
  CONTAINERS_SERVER_NAME,
  DOCKER_PATH,
  MEMORY_PATH,
  MEMORY_SERVER_NAME,
  PROCESSES_PATH,
  PROCESSES_SERVER_NAME,
  ROOM_PATH,
  ROOM_SERVER_NAME,
  type RoomAccess,
  SKILLS_PATH,
  SKILLS_SERVER_NAME,
  TASKS_PATH,
  TASKS_SERVER_NAME,
  type ToolCaller,
  type ToolTokens,
} from "./access.ts";
import type { RoomCoordinator } from "./coordinator.ts";
import { drawDiagram, drawMap } from "./diagram.ts";

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
      "Read the task room: the latest messages, newest first, each cut in the middle when long. Use before_seq to read further back. Pass item (an id from a cut marker) to read that one message whole.",
    input: z.object({
      limit: z.number().int().min(1).max(50).default(20),
      before_seq: z.number().int().positive().optional(),
      item: z.string().trim().min(1).max(200).optional(),
    }),
  },
  {
    name: "post",
    description:
      'Post a message to the room now, as yourself, without ending your turn. It wakes nobody: to hand work on, use mention, or start a line of your final reply with "@name:". A name in the middle of a sentence wakes nobody.',
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
  {
    name: "ask",
    description:
      "Post a question card to the room: one or more questions with preset options (shown as buttons or a dropdown) and optionally a free-text field. The owner's answer goes back to you as your next message. Use it whenever you need a decision from the owner (which approach, which option, whether to do something). Do not use it to ask for a merge or a review: majhi shows the owner a review card with Ship and Ask for changes when your work is done. A question in plain text is only a fallback.",
    input: z.object({
      questions: z
        .array(
          z.object({
            id: z.string().min(1),
            question: z.string().min(1).max(500),
            options: z.array(z.object({ id: z.string(), label: z.string() })),
            default: z.string().optional(),
            freeText: z.boolean().default(false),
          }),
        )
        .min(1),
    }),
  },
  {
    name: "uploads_create",
    description:
      "Turn a file in your own task folder (like attachments/image.png) into an upload id. Pass the id in the attachments of tasks_create or tasks_split, or give the file path itself there. Copies the file; the original stays. Allowed: images, pdf, text files, zip, up to 20 MB. The id is kept for 24 hours and can be used once.",
    input: z.object({ path: z.string().trim().min(1).max(1000) }),
  },
  {
    name: "record_plan",
    description:
      "Record your plan for this task: who does what, in which order, and why that is cheaper or faster. The room shows it as a plan line, and majhi keeps it on the task with the tokens each agent used, so later plans can be compared. Call it again when the plan changes, for example after the owner replies.",
    input: TeamPlanSchema,
  },
  {
    name: "show_diagram",
    description:
      "Draw any diagram in the chat for the owner: a flow, steps, a sequence between actors, a timeline, a tree or mind map, a state machine, or how services connect. Prefer this over ASCII art. Give a title, nodes (id, label, optional sub line, kind tag, group = the id of the box it sits inside, tone) and edges (from, to, optional label, type http|queue|data|lib|step, style solid|dashed|dotted, tone, arrow end|both|none). layout: flow (left to right, the default), top-down, tree (a hierarchy), radial (a mind map around focus), sequence (one lane per actor, edges in the order given are the messages; actors sets the lane order), timeline (events in the order given along one axis) or state (a state machine with transitions). At most 40 nodes, 80 edges and 60 characters per label. Everything you write is shown as plain text.",
    input: DiagramSpecSchema,
  },
  {
    name: "show_map",
    description:
      "Draw the stored map of how this workspace's projects connect in the chat for the owner: projects, libraries, databases, queues and outside services with the lines between them. Give around (a project id) to draw only what is within depth lines of it (1 or 2). Give journey (a journey's id or name) to draw one journey as a numbered sequence diagram instead. Your own workspace only. Say so if the workspace has no map yet.",
    input: ShowMapInputSchema,
  },
  { name: "code_graph", description: CODE_GRAPH_DESCRIPTION, input: CodeGraphInputSchema },
];

/** The tools a chat is offered from majhi-room. */
const DRAWING_TOOLS: ReadonlySet<string> = new Set(["show_diagram", "show_map"]);

// ---------------------------------------------------------------------------
// majhi-tasks (5.4a, 5.10)

/** Each tool is one command, run under the approval policy like the captain's. */
const TASK_TOOLS: (Tool & { command: CommandName })[] = [
  { name: "list", command: "tasks.list", description: "List the tasks of your org, newest first." },
  { name: "get", command: "tasks.get", description: "Show one task with its repos, team and links." },
  {
    name: "create",
    command: "tasks.create",
    description:
      "Create a task. Give a short title (under 80 characters, what the task is) and put the full description in text (what to do, why, how to check it). List in repos only the projects the task will change, each with an optional base: only those get a branch and a worktree. base (the starting branch) is set only there, never from words in title or text; without it the project's base is used, and a base the repo does not have falls back to the project's with a warning. Naming a project in text attaches nothing, and agents can read every registered project without listing it, so never list a repo only to read it or to tell the owner about it. To attach a file you have, pass its path in your task folder (like attachments/image.png) or an upload id in attachments. For an investigation (reading code to answer a question, such as why something fails), set readOnly true: the repos are mounted read-only and the task gets no branch, no worktree, no Changes and no Ship. Create a code task only when code must change. With parent, it becomes a subtask; with dependsOn, it waits for those tasks. For a fix found in an ops task, set followUpOf to that task: the new task is linked to it as a follow-up, and it never starts without the owner, so create it with start false and list the repos to change in repos. It does not start unless start is true and the owner allows it. To start it later, use start.",
  },
  {
    name: "split",
    command: "tasks.split",
    description:
      "Split a task into subtasks, in order. Each subtask lists in repos only the projects it will change; names in its text attach nothing. A subtask can get files in its attachments (a path in your task folder, like attachments/image.png, or an upload id). A subtask can wait for earlier ones (dependsOn: their positions, from 0). when: ready stacks its branch on the one it waits for. The subtasks do not start by themselves: to start one, use start.",
  },
  {
    name: "uploads_create",
    command: "uploads.create",
    description:
      "Turn a file in your own task folder (like attachments/image.png) into an upload id for attachments. Copies the file; the original stays. Allowed: images, pdf, text files, zip, up to 20 MB. The id is kept for 24 hours and can be used once. You can also pass the path itself in attachments.",
  },
  {
    name: "start",
    command: "tasks.start",
    description:
      "Start a task: create its worktrees and wake its agent. Your org's setting says which tasks you may start without asking the owner (by default your subtasks); for any other, the owner gets an approval card. A fix task (made with followUpOf) always gets the approval card. A task that waits on an unfinished dependency does not start early: it starts by itself when they are done.",
  },
  {
    name: "update",
    command: "tasks.update",
    description:
      "Change a task's title, description or coordination mode, or its starting branch (base, the branch its worktree is cut from) while it has not started. With more than one repo, give project too. A base the repo does not have is refused.",
  },
  {
    name: "plan",
    command: "tasks.plan",
    description:
      "Check what is safe to start now: for each waiting task (or the subtasks of one parent), whether it overlaps the running tasks' files, and whether its account has room in the 5-hour and weekly windows. Changes nothing.",
  },
  {
    name: "close",
    command: "tasks.close",
    description:
      "Mark a subtask done once you reviewed what it delivered and its work is shipped: merged, pushed or in a pull request. Refused while its branch has commits that are not, whatever you pass: merge it first with the merge tool if you have the Merge permission (a push or a pull request needs the owner's approval or an org policy), or leave it in review for the owner to ship or close. The tasks waiting for it can then start, and the parent closes when every subtask is done.",
  },
  {
    name: "merge",
    command: "tasks.merge",
    description:
      "Merge a task's branch into a local branch in the owner's checkout: its base by default, or the branch the owner names (dev, staging). Never pushes. Only for agents with the Merge permission, once the checks pass.",
  },
  {
    name: "change_task_branch",
    command: "tasks.changeBranch",
    description:
      "Change another task's branch: commit a change inside that task's own worktree, so its files and index stay in step with the branch. Give base, the commit of that branch you read the files from (run `git rev-parse <branch>` before you read them): if the branch has moved since, the call is refused and nothing is written, so read again and retry. Send a patch (a unified diff from the repo root) for small changes; send whole files (path from the repo root, full new content) only for new files or full rewrites. Give exactly one of patch or files. Never commit to another task's branch with git: majhi refuses it, and that task's agents would undo the change. Only for tasks in your own org. Refused while that task's agents are working or have work queued: retry when it is idle, paused or in review. Give the reason: the task's room shows who changed which files and why. Returns the commit.",
  },
  {
    name: "set_lead",
    command: "tasks.setLead",
    description:
      "Hand the lead of your task to another agent (only the current lead may): when your account is at its limit, the task needs another skill or model, or you are stuck. Give agent (a teammate, or an agent allowed in the task's workspace, who is added). You stay as a builder unless keepOldLead is false. majhi posts a handover note with the plan, what is done and what is next, and wakes the new lead with it. Say why in reason.",
  },
  {
    name: "staff",
    command: "tasks.staff",
    description:
      "Propose a team for a task: who should lead and who should join, weighing size, accounts, limits, budgets, cost and past results. Changes nothing.",
  },
  {
    name: "link",
    command: "tasks.link",
    description: "Make a task wait for another (depends-on), or a subtask of another (parent).",
  },
].map((t) => ({
  ...t,
  command: t.command as CommandName,
  input: agentInput(t.command as CommandName),
}));

/** A command's input as an agent's tool takes it: without the fields only the owner gives (push). */
export function agentInput(command: CommandName): z.ZodObject {
  const input = commands[command].input as unknown as z.ZodObject;
  const hidden = OWNER_ONLY_INPUTS[command] ?? [];
  if (hidden.length === 0) return input;
  return z.object(Object.fromEntries(Object.entries(input.shape).filter(([k]) => !hidden.includes(k))));
}

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
  config: ConfigService;
  room: RoomService;
  store: Store;
  agents: AgentStore;
  projects: ProjectService;
  processes: ProcessManager;
  /** Absent when majhi cannot run containers: there is no `/mcp/containers` then. */
  containers?: ContainersMcpDeps;
  memory: MemoryMcpDeps;
  /** `majhi-skills`: look up a run's own skills. */
  skills: SkillsMcpDeps;
  /** `show_map`: the stored map of the workspace a task belongs to. Never another workspace's. */
  maps: { forTask(task: string): { org: string; map: ProjectMap; journeys: JourneyView[] } };
  /** `code_graph`: the code graph of the task's own repos. Absent: the tool is not offered. */
  codeGraph?: CodeGraphTools | undefined;
  /** `majhi-connections` (5.14). Absent: there is no `/mcp/connections`. */
  connections?: ConnectionsMcpDeps;
}

/**
 * `/mcp/room`, `/mcp/tasks`, `/mcp/processes` and `/mcp/memory`: stateless streamable HTTP like `/mcp`, one bearer token per agent
 * session. `majhi-tasks` runs its commands through the captain's approval policy, and an org agent
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
  const containers = deps.containers;
  if (containers !== undefined) {
    app.post(DOCKER_PATH, async (c) => {
      const origin = c.req.header("origin");
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        return c.json({ error: "docker is not for web pages" }, 403);
      }
      const token = bearerOf(c.req.header("authorization"));
      const caller = token === undefined ? undefined : deps.access.docker.lookup(token);
      if (caller === undefined) return c.json({ error: "A valid bearer token is required" }, 401);
      const body = TaskDockerRequestSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json({ error: formatIssues(body.error).join("; ") }, 400);
      try {
        return c.json(
          await containers.containers.taskDocker(caller.task, body.data, {
            ask: (image) => containers.askImage(caller, image),
            signal: c.req.raw.signal,
          }),
        );
      } catch (err) {
        return c.json({ code: 125, stdout: "", stderr: `docker: ${errorMessage(err)}\n` });
      }
    });
    app.all(CONTAINERS_PATH, (c) =>
      serve(
        c.req.raw,
        c.req.header("origin"),
        c.req.header("authorization"),
        deps.access.containers,
        CONTAINERS_SERVER_NAME,
        (caller) => containersServer(caller, containers),
      ),
    );
  }
  app.all(MEMORY_PATH, (c) =>
    serve(
      c.req.raw,
      c.req.header("origin"),
      c.req.header("authorization"),
      deps.access.memory,
      MEMORY_SERVER_NAME,
      (caller) => memoryServer(caller, deps.memory),
    ),
  );
  app.all(SKILLS_PATH, (c) =>
    serve(
      c.req.raw,
      c.req.header("origin"),
      c.req.header("authorization"),
      deps.access.skills,
      SKILLS_SERVER_NAME,
      (caller) => skillsServer(caller, deps.skills),
    ),
  );
  const connections = deps.connections;
  if (connections !== undefined) {
    app.all(CONNECTIONS_PATH, (c) =>
      serve(
        c.req.raw,
        c.req.header("origin"),
        c.req.header("authorization"),
        deps.access.connections,
        CONNECTIONS_SERVER_NAME,
        (caller) => connectionsServer(caller, connections),
      ),
    );
  }
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
  // Only the lead records the plan, so only the lead is offered the tool.
  const isLead = () => deps.store.tasks.get(caller.task)?.team[0] === caller.agent;
  // A chat (the owner's chats and the captain's threads) has no team: it is offered the drawing tools only.
  const isChat = () => deps.store.tasks.get(caller.task)?.kind === "chat";
  const offered = () =>
    isChat()
      ? ROOM_TOOLS.filter((t) => DRAWING_TOOLS.has(t.name))
      : ROOM_TOOLS.filter(
          (t) =>
            (t.name !== "code_graph" || deps.codeGraph !== undefined) &&
            (t.name !== "record_plan" || isLead()),
        );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed(offered(), false) }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<Result> => {
    const tool = offered().find((t) => t.name === request.params.name);
    if (tool === undefined) return fail(`There is no tool ${request.params.name}.`);
    const parsed = tool.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return fail(`Invalid arguments:\n${formatIssues(parsed.error).join("\n")}`);
    const args = parsed.data as Record<string, unknown>;
    try {
      switch (tool.name) {
        case "show_diagram":
          return ok(drawDiagram(deps.room, caller, parsed.data as DiagramSpec));
        case "code_graph":
          return ok(
            await (deps.codeGraph as CodeGraphTools).call(caller.task, parsed.data as CodeGraphInput),
          );
        case "show_map": {
          const { org, map, journeys } = deps.maps.forTask(caller.task);
          return ok(
            drawMap(
              deps.room,
              caller,
              org,
              map,
              args as { around?: string; depth: 1 | 2; journey?: string },
              journeys,
            ),
          );
        }
        case "read_recent":
          if (typeof args.item === "string") return ok(deps.coordinator.readItem(caller.task, args.item));
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
        case "uploads_create": {
          const made = await deps.admin.call(caller, toolName("uploads.create"), { path: args.path });
          return made.isError ? fail(made.text) : ok(made.text);
        }
        case "record_plan":
          return ok(await deps.tasks.recordPlan(caller.task, caller.agent, args as TeamPlan));
        case "ask": {
          const questions = args.questions as Array<{
            id: string;
            question: string;
            options: Array<{ id: string; label: string }>;
            default?: string | undefined;
            freeText: boolean;
          }>;
          const item = await deps.coordinator.postAskCard(caller.task, caller.agent, questions);
          return ok(JSON.stringify({ item }));
        }
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
      if (tool.command === "tasks.setLead") {
        const target = typeof args.task === "string" ? deps.store.tasks.get(args.task) : undefined;
        if (target === undefined) return fail("Give the id of the task.");
        if (target.team[0] !== caller.agent) {
          return fail(
            `Only the lead, @${target.team[0] ?? "nobody"}, can hand over ${target.id}. Say in the room that it should change hands.`,
          );
        }
        const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 500) : "";
        const done = await deps.admin.runAllowed(caller, "tasks.setLead", args, { reason });
        return done.isError ? fail(done.text) : ok(done.text);
      }
      if (tool.command === "tasks.plan" && fm.scope !== "root" && args.id === undefined) {
        return fail("Give the id of the parent or the task to check.");
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
        // In a captain lane, only the lane's workspace (5.18).
        return ok(JSON.stringify(await deps.admin.narrowForLane(caller.task, rows), null, 2));
      }
      // A fix task never starts without the owner: no lead_start, no `auto` mode, no saved rule.
      let confirm = false;
      if (tool.command === "tasks.start") {
        confirm = isFixTask(deps, args.id);
        if (!confirm) {
          const started = await leadStart(deps, caller, args);
          if (started !== undefined) return started;
        }
      }
      if (tool.command === "tasks.create" && typeof args.followUpOf === "string") args.start = false;
      const result = await deps.admin.call(caller, toolName(tool.command), args, { confirm });
      return result.isError ? fail(result.text) : ok(result.text);
    } catch (err) {
      return fail(errorMessage(err));
    }
  });
  return server;
}

/** A task made as the follow-up of another (an ops task's fix task): it holds a `follow-up` link. */
function isFixTask(deps: RoomMcpDeps, id: unknown): boolean {
  const task = typeof id === "string" ? deps.store.tasks.get(id) : undefined;
  return task?.links.some((l) => l.type === "follow-up") === true;
}

/**
 * A lead starting a task. When the org's `lead_start` allows it, the task starts at once with an
 * `applied` card, a row in the audit, and a note in the target's room. Undefined means the call
 * goes the normal way, to an approval card; another org is refused here.
 */
async function leadStart(
  deps: RoomMcpDeps,
  caller: ToolCaller,
  args: Record<string, unknown>,
): Promise<Result | undefined> {
  const id = typeof args.id === "string" ? args.id : undefined;
  const callerTask = deps.store.tasks.get(caller.task);
  const target = id === undefined ? undefined : deps.store.tasks.get(id);
  if (id === undefined || callerTask === undefined || target === undefined) return undefined;
  const sections = await deps.config.sections();
  const check = leadMayStart({
    callerTask,
    callerAgent: caller.agent,
    target: { ...target, parent: target.links.find((l) => l.type === "parent")?.task },
    setting:
      (callerTask.org === undefined ? undefined : sections.orgs[callerTask.org]?.lead_start) ??
      DEFAULT_LEAD_START,
  });
  if (!check.ok) return check.hard ? fail(check.why) : undefined;
  if ("running" in check) return ok(`${id} is already running.`);

  const waiting = deps.store.tasks.unmetDependencies(id);
  const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 500) : "";
  const result = await deps.admin.runAllowed(
    caller,
    "tasks.start",
    { id },
    {
      reason,
      accept: (e) => waiting.length > 0 && e.startsWith("Waiting on"),
      accepted: `Waiting on ${waiting.join(", ")}. It starts by itself when they are done.`,
    },
  );
  // Held by a dependency or not, the owner can see that a lead did this.
  const title =
    waiting.length === 0
      ? `Started by @${caller.agent} from ${caller.task}`
      : `@${caller.agent} started it from ${caller.task}; waiting on ${waiting.join(", ")}`;
  if (!result.isError) {
    deps.store.permissions.log({
      task: id,
      agent: caller.agent,
      kind: "tasks.start",
      title,
      decision: "allow",
      by: "lead",
      at: new Date().toISOString(),
    });
    deps.room.post(id as never, `info:${crypto.randomUUID()}`, {
      type: "system",
      level: "info",
      text: title,
    });
  }
  return result.isError ? fail(result.text) : ok(result.text);
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
    args.followUpOf,
    ...(Array.isArray(args.dependsOn) ? args.dependsOn : []),
  ];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const task = deps.store.tasks.get(id);
    if (task !== undefined && !canWorkIn(fm, task.org)) return `${id} is not in an org @${fm.id} works in.`;
  }
  // An org agent never gets another org's connection, so it cannot hand one to a task either.
  if (command === "tasks.create" && Array.isArray(args.connections) && args.connections.length > 0) {
    const sections = await deps.config.sections();
    const own = { ...sections.connections, ...sections.orgs[fm.scope]?.connections };
    const foreign = args.connections.find((c) => typeof c !== "string" || own[c] === undefined);
    if (foreign !== undefined)
      return `@${fm.id} can only name connections of ${fm.scope}, not ${String(foreign)}.`;
  }
  // The repos a new task changes are listed on purpose; names in the text attach nothing.
  const picks: unknown[] =
    command === "tasks.create"
      ? [args.repos]
      : command === "tasks.split" && Array.isArray(args.children)
        ? args.children.map((c) =>
            typeof c === "object" && c !== null ? (c as { repos?: unknown }).repos : undefined,
          )
        : [];
  const projects = await deps.projects.infos();
  for (const pick of picks) {
    const listed = Array.isArray(pick)
      ? pick.flatMap((r) =>
          typeof r === "object" && r !== null && typeof (r as { project?: unknown }).project === "string"
            ? [(r as { project: string }).project]
            : [],
        )
      : [];
    const orgs = [...new Set(listed.flatMap((id) => projects.find((p) => p.id === id)?.org ?? []))];
    if (orgs.length > 1) return "Those repos are in more than one workspace.";
    const parentId = command === "tasks.split" ? args.task : args.parent;
    const parent = typeof parentId === "string" ? deps.store.tasks.get(parentId)?.org : undefined;
    const org = orgs[0] ?? (listed.length === 0 ? parent : undefined);
    if (org === undefined && listed.length === 0 && command === "tasks.create" && parent === undefined) {
      return `List a repo of your org in repos, or give a parent task: @${fm.id} cannot create a task without an org.`;
    }
    if (org !== undefined && !canWorkIn(fm, org)) return `@${fm.id} cannot create tasks in "${org}".`;
  }
  return undefined;
}
