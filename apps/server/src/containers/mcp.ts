import {
  type ContainerInfo,
  ContainerListInputSchema,
  ContainerLogsInputSchema,
  PreviewBuildInputSchema,
  PreviewRunInputSchema,
  PreviewStopInputSchema,
  ServiceStartInputSchema,
  ServiceStopInputSchema,
} from "@majhi/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage, formatIssues } from "../errors.ts";
import { listLine } from "../processes/text.ts";
import { CONTAINERS_SERVER_NAME, type ToolCaller } from "../rooms/access.ts";
import type { AskImage, ContainerService, ScriptContainer } from "./service.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

const TOOLS = [
  {
    name: "preview_build",
    description:
      "Build the image of one of this task's repos (its Dockerfile) as the task's preview, on the task's own builder. Returns at once. majhi wakes you with the exit code and the end of the output when the build ends, so end your turn instead of waiting. One build at a time. The build cannot use secrets, ssh or anything outside the task folder.",
    input: PreviewBuildInputSchema,
  },
  {
    name: "preview_run",
    description:
      "Run the built preview image with a throwaway folder and nothing of the host: no real majhi.yaml, secrets, accounts or ~/.ssh. Returns the URL from this task's runners (curl it from your shell) and a link for the owner. Replaces a preview that runs. At most containers.per_task previews and services run at once in a task.",
    input: PreviewRunInputSchema,
  },
  {
    name: "preview_stop",
    description: "Stop the task's preview. It also stops when the task ends.",
    input: PreviewStopInputSchema,
  },
  {
    name: "service_start",
    description:
      "Start a service container for tests, like postgres or redis, from an image the owner allowed. It is reachable as <name>:<port> from this task's runners only, never from the host, and has only named volumes. An image that is not allowed yet asks the owner in the room: you get a message with the answer, then call service_start again. At most containers.per_task previews and services run at once in a task. Services and the preview stop while the task is in review or paused and start again when it runs; keep data you need in a named volume.",
    input: ServiceStartInputSchema,
  },
  {
    name: "service_stop",
    description:
      "Stop a service container, or remove a container a script started. Its named volumes keep their data until the task is done.",
    input: ServiceStopInputSchema,
  },
  {
    name: "list",
    description:
      "List this task's containers with their addresses: previews, services, and the containers its scripts started with docker run or docker compose. All of them are on the task's one network and reach each other by name.",
    input: ContainerListInputSchema,
  },
  {
    name: "logs",
    description:
      'The last lines of the output of the preview ("preview"), of a service or of a container a script started, by its name.',
    input: ContainerLogsInputSchema,
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

/** One container as the `list` tool shows it. */
function containerLine(c: ContainerInfo): string {
  const where = [
    c.url === undefined ? undefined : `from runners: ${c.url}`,
    c.hostUrl === undefined ? undefined : `owner: ${c.hostUrl}`,
  ]
    .filter((x) => x !== undefined)
    .join(", ");
  return `${c.name} (${c.kind}, ${c.image}): ${c.status}${where === "" ? "" : `, ${where}`}, ${c.process}`;
}

/** One container a script started, as the `list` tool shows it. */
function scriptLine(c: ScriptContainer): string {
  return `${c.name} (${c.compose ? "compose" : "container"}, ${c.image}): ${c.status}, reach it as ${c.name} from this task`;
}

export interface ContainersMcpDeps {
  containers: ContainerService;
  /** Asks the owner, through an approval card, to allow an image for this caller's task. */
  askImage: (caller: ToolCaller, image: string, service?: string) => ReturnType<AskImage>;
}

/** `majhi-containers` (PRV-53): one agent session's view of its own task's previews and services. */
export function containersServer(caller: ToolCaller, deps: ContainersMcpDeps): Server {
  const { containers } = deps;
  const server = new Server({ name: CONTAINERS_SERVER_NAME, version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed() }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<Result> => {
    const { task, agent } = caller;
    try {
      const tool = TOOLS.find((t) => t.name === request.params.name);
      if (tool === undefined) return fail(`There is no tool ${request.params.name}.`);
      const parsed = tool.input.safeParse(request.params.arguments ?? {});
      if (!parsed.success) return fail(`Invalid arguments:\n${formatIssues(parsed.error).join("\n")}`);
      switch (tool.name) {
        case "preview_build": {
          const p = await containers.previewBuild(
            task,
            agent,
            parsed.data as z.infer<typeof PreviewBuildInputSchema>,
            (image, service) => deps.askImage(caller, image, service),
          );
          return ok(
            `Started ${listLine(p, new Date().toISOString())}.\nmajhi wakes you when the build ends. You can end your turn now.`,
          );
        }
        case "preview_run": {
          const c = await containers.previewRun(
            task,
            agent,
            parsed.data as z.infer<typeof PreviewRunInputSchema>,
          );
          return ok(
            [
              `The preview runs. From this task's runners: ${c.url}.`,
              c.hostUrl === undefined ? "No host port yet." : `The owner's link: ${c.hostUrl}.`,
              "Read its output with logs (name: preview).",
            ].join("\n"),
          );
        }
        case "preview_stop":
          return ok(`Stopped ${containerLine(await containers.stop(task, "preview", "agent"))}.`);
        case "service_start": {
          const input = parsed.data as z.infer<typeof ServiceStartInputSchema>;
          const result = await containers.serviceStart(task, agent, input, (image, service) =>
            deps.askImage(caller, image, service),
          );
          if (result.status === "asked") {
            return ok(
              `${input.image} is not allowed yet. The owner was asked in the room; you get a message with the answer. Then call service_start again.`,
            );
          }
          const c = result.container;
          return ok(
            `Started service ${c.name} (${c.image}).${c.url === undefined ? "" : ` Reach it from this task's runners at ${c.url}.`} It is reachable from this task only.`,
          );
        }
        case "service_stop": {
          const input = parsed.data as z.infer<typeof ServiceStopInputSchema>;
          if (!containers.has(task, input.name)) {
            const removed = await containers.scriptStop(task, input.name);
            if (removed !== undefined) return ok(`Removed ${scriptLine(removed)}.`);
          }
          return ok(`Stopped ${containerLine(await containers.stop(task, input.name, "agent"))}.`);
        }
        case "list": {
          const all = containers.list(task);
          const scripted = await containers.scriptContainers(task);
          const lines = [...all.map(containerLine), ...scripted.map(scriptLine)];
          return ok(lines.length === 0 ? "No containers." : lines.join("\n"));
        }
        case "logs": {
          const input = parsed.data as z.infer<typeof ContainerLogsInputSchema>;
          if (!containers.has(task, input.name)) {
            const scripted = await containers.scriptLogs(task, input.name, input.lines);
            if (scripted !== undefined) {
              return ok(
                `${scriptLine(scripted.container)}\n\n${scripted.lines.length === 0 ? "(no output yet)" : scripted.lines.join("\n")}`,
              );
            }
          }
          const out = containers.logs(task, input.name, input.lines);
          return ok(
            `${containerLine(out.container)}\n\n${out.lines.length === 0 ? "(no output yet)" : out.lines.join("\n")}`,
          );
        }
      }
    } catch (err) {
      return fail(errorMessage(err));
    }
  });
  return server;
}
