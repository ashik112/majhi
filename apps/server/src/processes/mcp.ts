import {
  ProcessListInputSchema,
  ProcessOutputInputSchema,
  ProcessRestartInputSchema,
  ProcessStartInputSchema,
  ProcessStopInputSchema,
} from "@majhi/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage, formatIssues } from "../errors.ts";
import { PROCESSES_SERVER_NAME, type ToolCaller } from "../rooms/access.ts";
import type { ProcessManager } from "./manager.ts";
import { listLine } from "./text.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

const TOOLS = [
  {
    name: "start",
    description:
      "Start a command in the background, in the task folder or a folder inside it. Returns at once. With wait (default), majhi wakes you with the exit code and the last output when it ends, and the task keeps running meanwhile: end your turn instead of waiting. Use wait: false for dev servers and watchers. At most 5 run per task.",
    input: ProcessStartInputSchema,
  },
  {
    name: "list",
    description: "List this task's background processes: running and recently ended.",
    input: ProcessListInputSchema,
  },
  {
    name: "output",
    description: "The last lines of a process's output, stdout and stderr together.",
    input: ProcessOutputInputSchema,
  },
  {
    name: "stop",
    description: "Stop a running process. Nothing wakes you for it.",
    input: ProcessStopInputSchema,
  },
  {
    name: "restart",
    description: "Stop a process if it runs, then start the same command again under the same id.",
    input: ProcessRestartInputSchema,
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

/** `majhi-processes` (5.15): one agent session's view of its own task's processes. */
export function processesServer(caller: ToolCaller, processes: ProcessManager): Server {
  const server = new Server({ name: PROCESSES_SERVER_NAME, version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed() }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<Result> => {
    const { task, agent } = caller;
    const now = () => new Date().toISOString();
    try {
      switch (request.params.name) {
        case "start": {
          const args = parse(ProcessStartInputSchema, request.params.arguments);
          if (typeof args === "string") return fail(args);
          const p = await processes.start({ task, agent, ...args });
          const how = p.wait
            ? "majhi wakes you when it ends. You can end your turn now."
            : "It keeps running. Nothing wakes you for it.";
          return ok(`Started ${listLine(p, now())}.\n${how}`);
        }
        case "list": {
          const all = processes.list(task);
          // Each line shows its status and exit code: an ended run is read, so its end wakes nobody.
          for (const p of all) processes.markRead(task, p, agent);
          return ok(all.length === 0 ? "No processes." : all.map((p) => listLine(p, now())).join("\n"));
        }
        case "output": {
          const args = parse(ProcessOutputInputSchema, request.params.arguments);
          if (typeof args === "string") return fail(args);
          const p = processes.get(task, args.id);
          if (p === undefined) return fail(`There is no process ${args.id}.`);
          const lines = processes.output(task, args.id, args.lines);
          processes.markRead(task, p, agent);
          return ok(`${listLine(p, now())}\n\n${lines.length === 0 ? "(no output yet)" : lines.join("\n")}`);
        }
        case "stop": {
          const args = parse(ProcessStopInputSchema, request.params.arguments);
          if (typeof args === "string") return fail(args);
          return ok(listLine(await processes.stop(task, args.id, "agent"), now()));
        }
        case "restart": {
          const args = parse(ProcessRestartInputSchema, request.params.arguments);
          if (typeof args === "string") return fail(args);
          return ok(`Restarted ${listLine(await processes.restart(task, args.id, agent), now())}.`);
        }
      }
      return fail(`There is no tool ${request.params.name}.`);
    } catch (err) {
      return fail(errorMessage(err));
    }
  });
  return server;
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> | string {
  const parsed = schema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : `Invalid arguments:\n${formatIssues(parsed.error).join("\n")}`;
}
