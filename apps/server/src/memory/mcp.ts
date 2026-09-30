import {
  GLOBAL_SCOPE,
  MemoryListRecentToolSchema,
  MemoryProposeToolSchema,
  MemoryRecallToolSchema,
  type MemoryScope,
  orgScope,
} from "@majhi/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage, formatIssues } from "../errors.ts";
import { MEMORY_SERVER_NAME, type ToolCaller } from "../rooms/access.ts";
import { capFacts, factLine } from "./recall.ts";
import type { MemoryService } from "./service.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** What a task's agents may see: its org, and the scopes that follow from it. */
export interface AgentScope {
  org?: string | undefined;
  scopes: readonly MemoryScope[];
}

export interface MemoryMcpDeps {
  memory: MemoryService;
  /** Resolved on every call, so a project added or moved to another org counts at once. */
  scopeOf: (task: string) => Promise<AgentScope | undefined>;
}

const TOOLS = [
  {
    name: "recall",
    description:
      "Search majhi's memory for facts learned in earlier tasks (conventions, commands, decisions). " +
      "Returns up to about 500 tokens of active facts, best match first. You only see global facts, your task's org and that org's projects.",
    input: MemoryRecallToolSchema,
  },
  {
    name: "propose",
    description:
      "Propose one short fact worth keeping for later tasks. It stays pending until the owner approves it: you cannot make it active. " +
      "Only lasting facts (a convention, a command that works, a decision and why). Never task chatter, secrets or personal data.",
    input: MemoryProposeToolSchema,
  },
  {
    name: "list_recent",
    description: "The most recently added active facts you may see, newest first.",
    input: MemoryListRecentToolSchema,
  },
] as const;

function listed() {
  return TOOLS.map((t) => {
    const { $schema: _dropped, ...rest } = z.toJSONSchema(t.input, { io: "input" }) as Record<
      string,
      unknown
    >;
    return { name: t.name, description: t.description, inputSchema: { ...rest, type: "object" as const } };
  });
}

/** `majhi-memory` (5.6): one agent session's view of memory, limited to the scopes of its task's org. */
export function memoryServer(caller: ToolCaller, deps: MemoryMcpDeps): Server {
  const server = new Server({ name: MEMORY_SERVER_NAME, version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed() }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<Result> => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (tool === undefined) return fail(`There is no tool ${request.params.name}.`);
    const parsed = tool.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return fail(`Invalid arguments:\n${formatIssues(parsed.error).join("\n")}`);
    const allowed = await deps.scopeOf(caller.task);
    if (allowed === undefined) return fail(`Task ${caller.task} does not exist.`);
    try {
      switch (tool.name) {
        case "recall": {
          const args = MemoryRecallToolSchema.parse(parsed.data);
          const scopes = pick(allowed, args.scope);
          if (typeof scopes === "string") return fail(scopes);
          const hits = await deps.memory.search(args.query, { scopes });
          const facts = capFacts(hits.map((h) => h.fact));
          deps.memory.noteUse(caller.task, facts);
          return ok(facts.length === 0 ? "No facts found." : facts.map(factLine).join("\n"));
        }
        case "propose": {
          const args = MemoryProposeToolSchema.parse(parsed.data);
          const scope = args.scope ?? (allowed.org === undefined ? GLOBAL_SCOPE : orgScope(allowed.org));
          if (!allowed.scopes.includes(scope)) return fail(refusal(scope, allowed));
          const fact = await deps.memory.propose({
            text: args.text,
            scope,
            task: caller.task,
            agent: caller.agent,
          });
          return ok(`Proposed fact ${fact.id} in ${scope}. It is ${fact.status} until the owner decides.`);
        }
        default: {
          const args = MemoryListRecentToolSchema.parse(parsed.data);
          const scopes = pick(allowed, args.scope);
          if (typeof scopes === "string") return fail(scopes);
          const facts = deps.memory.list({ scopes, status: "active", limit: args.limit });
          return ok(facts.length === 0 ? "No facts yet." : facts.map(factLine).join("\n"));
        }
      }
    } catch (err) {
      return fail(errorMessage(err));
    }
  });
  return server;
}

/** The scopes to read: the one asked for when it is allowed, else all allowed. A string is the refusal. */
function pick(allowed: AgentScope, asked: MemoryScope | undefined): readonly MemoryScope[] | string {
  if (asked === undefined) return allowed.scopes;
  return allowed.scopes.includes(asked) ? [asked] : refusal(asked, allowed);
}

function refusal(scope: MemoryScope, allowed: AgentScope): string {
  return `You cannot use ${scope} in this task. You may use: ${allowed.scopes.join(", ")}.`;
}
