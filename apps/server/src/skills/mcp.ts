import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatIssues } from "../errors.ts";
import { SKILLS_SERVER_NAME, type ToolCaller } from "../rooms/access.ts";
import { foundLines, rankSkills } from "./find.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

const FindInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("A few words about the work, like 'review a merge request'"),
});

const TOOL = {
  name: "find",
  description:
    "Find a skill the owner turned on for you. Give a few words about the work; get up to 5 matches with a one-line description and the path of each SKILL.md. Read the file of a match before you start, and follow it.",
};

export interface SkillsMcpDeps {
  /** The skills this agent's run has (descriptions included), and the run's folder of copies. Undefined: none. */
  forRun: (
    caller: ToolCaller,
  ) => Promise<{ dir: string; skills: { name: string; description: string }[] } | undefined>;
}

/** `majhi-skills`: look up the run's own skills on demand, so none of them sits in the prompt. */
export function skillsServer(caller: ToolCaller, deps: SkillsMcpDeps): Server {
  const server = new Server({ name: SKILLS_SERVER_NAME, version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        ...TOOL,
        inputSchema: {
          type: "object" as const,
          properties: { query: { type: "string", description: "A few words about the work" } },
          required: ["query"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<Result> => {
    if (request.params.name !== TOOL.name) return fail(`There is no tool ${request.params.name}.`);
    const parsed = FindInputSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return fail(`Invalid arguments:\n${formatIssues(parsed.error).join("\n")}`);
    const mine = await deps.forRun(caller);
    if (mine === undefined) return ok("No skills are turned on for you in this run.");
    return ok(foundLines(mine.dir, rankSkills(mine.skills, parsed.data.query)));
  });
  return server;
}
