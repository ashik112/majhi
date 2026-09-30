import {
  GLOBAL_SCOPE,
  MemoryBriefToolSchema,
  MemoryListRecentToolSchema,
  MemoryProposeToolSchema,
  MemoryRecallToolSchema,
  MemoryRecordsToolSchema,
  type MemoryScope,
  MemoryThreadsToolSchema,
  orgScope,
  parseScope,
  projectScope,
  RECORD_SECTION_TITLES,
  RECORD_SECTIONS,
  type TaskRecord,
} from "@majhi/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage, formatIssues } from "../errors.ts";
import { MEMORY_SERVER_NAME, type ToolCaller } from "../rooms/access.ts";
import { capFacts, factLine, TASK_MEMORY_CHARS } from "./recall.ts";
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
      "Search majhi's lessons from earlier tasks: non-obvious gotchas and how to avoid them. " +
      "Returns up to about 500 tokens, best match first. You only see global lessons, your task's org and that org's projects.",
    input: MemoryRecallToolSchema,
  },
  {
    name: "propose",
    description:
      "Propose a lesson for later tasks: a non-obvious gotcha you actually ran into, what went wrong and how to avoid it. Most tasks have none. " +
      "Not a rule the repo docs already state, not task progress, never a secret or personal data. majhi curates it; the owner can undo.",
    input: MemoryProposeToolSchema,
  },
  {
    name: "list_recent",
    description: "The most recently kept lessons you may see, newest first.",
    input: MemoryListRecentToolSchema,
  },
  {
    name: "records",
    description:
      "Search the records of finished tasks: what each was asked, what it did, the decisions and why, where it landed and what it left. " +
      "Use it before changing an area another task worked on. Returns the best 3 in full. You only see your org's projects.",
    input: MemoryRecordsToolSchema,
  },
  {
    name: "brief",
    description:
      "A project's living brief: what it is, its architecture (main parts and where they live), current state, plans and known problems.",
    input: MemoryBriefToolSchema,
  },
  {
    name: "threads",
    description: "Open threads: what finished tasks left to do, known issues and follow-ups, per project.",
    input: MemoryThreadsToolSchema,
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
          const outcome: Record<typeof fact.status, string> = {
            pending: "It is pending until the owner decides.",
            active: "It was kept. The owner can undo that.",
            rejected: "It was not kept (a duplicate, already in the repo docs, chatter or private data).",
            retired: "It is retired.",
          };
          return ok(`Proposed fact ${fact.id} in ${scope}. ${outcome[fact.status]}`);
        }
        case "records": {
          const args = MemoryRecordsToolSchema.parse(parsed.data);
          if (args.project !== undefined && !allowed.scopes.includes(projectScope(args.project)))
            return fail(refusal(projectScope(args.project), allowed));
          const hits = await deps.memory.project.records({
            query: args.query,
            // Records are never global: the org and its projects only.
            scopes: allowed.scopes.filter((s) => s !== GLOBAL_SCOPE),
            project: args.project,
            limit: 3,
          });
          const text = hits.map((h) => recordText(h.record)).join("\n\n");
          return ok(hits.length === 0 ? "No task records found." : text.slice(0, TASK_MEMORY_CHARS * 2));
        }
        case "brief": {
          const args = MemoryBriefToolSchema.parse(parsed.data);
          if (!allowed.scopes.includes(projectScope(args.project)))
            return fail(refusal(projectScope(args.project), allowed));
          const brief = deps.memory.project.currentBrief(args.project);
          return ok(
            brief === undefined
              ? `${args.project} has no brief yet.`
              : `# Brief of ${args.project} (version ${brief.version})\n\n${brief.body}`,
          );
        }
        case "threads": {
          const args = MemoryThreadsToolSchema.parse(parsed.data);
          if (args.project !== undefined && !allowed.scopes.includes(projectScope(args.project)))
            return fail(refusal(projectScope(args.project), allowed));
          const projects =
            args.project !== undefined
              ? [args.project]
              : allowed.scopes.flatMap((s) => {
                  const p = parseScope(s);
                  return p?.kind === "project" ? [p.id] : [];
                });
          const threads = deps.memory.project.threads({ projects, status: "open", limit: 100 });
          return ok(
            threads.length === 0
              ? "No open threads."
              : threads
                  .map(
                    (t) =>
                      `- [${t.project ?? "no project"}] ${t.text} (from ${t.task}${t.follow_up === undefined ? "" : `, follow-up ${t.follow_up}`})`,
                  )
                  .join("\n"),
          );
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

/** A record in full, as an agent reads it. */
function recordText(r: TaskRecord): string {
  const where = r.repos
    .map(
      (repo) =>
        `${repo.project}: ${repo.merged ? `merged into ${repo.base}` : "not merged"}${repo.head === undefined ? "" : ` at ${repo.head}`}`,
    )
    .join("; ");
  return [
    `## ${r.task}: ${r.title} (${r.created_at.slice(0, 10)}${where === "" ? "" : `; ${where}`})`,
    ...RECORD_SECTIONS.filter((s) => r[s].trim() !== "").map(
      (s) => `${RECORD_SECTION_TITLES[s]}: ${r[s].trim()}`,
    ),
  ].join("\n");
}
