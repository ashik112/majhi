import { DecideRequestSchema } from "@majhi/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { z } from "zod";
import { bearerOf } from "../admin/tokens.ts";
import { errorMessage, formatIssues } from "../errors.ts";
import { isLoopbackOrigin } from "../http/origin.ts";
import { DECIDE_PATH, DECIDE_SERVER_NAME, type DecisionService } from "./service.ts";
import type { DecideTokens } from "./tokens.ts";

const TOOL = {
  name: "decide",
  description:
    "Ask a fast decision model typed questions about some text and get answers with probabilities. " +
    "Question types: choice (pick one of 2 to 20 options), score (an integer from min to max), noul (is the statement in instructions true). " +
    "Use it for small classification decisions, not for writing or reasoning. The state is trimmed to about 500 tokens.",
  inputSchema: z.toJSONSchema(DecideRequestSchema, { io: "input", unrepresentable: "any" }),
};

export interface DecideMcpDeps {
  tokens: DecideTokens;
  decisions: DecisionService;
}

/** `/mcp/decide`: the `majhi-decide` MCP server. Stateless like `/mcp`; a bearer token per agent session. */
export function decideMcpRoutes({ tokens, decisions }: DecideMcpDeps): Hono {
  const app = new Hono();
  app.all(DECIDE_PATH, async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return c.json({ error: `${DECIDE_SERVER_NAME} is not for web pages` }, 403);
    }
    const token = bearerOf(c.req.header("authorization"));
    const caller = token === undefined ? undefined : tokens.lookup(token);
    if (token === undefined || caller === undefined) {
      return c.json({ error: "A valid bearer token is required" }, 401, { "www-authenticate": "Bearer" });
    }
    const server = new Server({ name: DECIDE_SERVER_NAME, version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [TOOL] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
      if (request.params.name !== TOOL.name) return fail(`There is no tool ${request.params.name}.`);
      const parsed = DecideRequestSchema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) return fail(`Invalid arguments:\n${formatIssues(parsed.error).join("\n")}`);
      const limit = (await decisions.settings()).per_run_limit;
      const calls = tokens.count(token) ?? limit + 1;
      if (calls > limit) {
        return fail(`Decision limit reached: ${limit} calls in this run. Decide yourself or ask the owner.`);
      }
      try {
        const result = await decisions.decide(parsed.data, {
          use: "tool",
          task: caller.task,
          agent: caller.agent,
        });
        const text = JSON.stringify({
          answers: result.answers,
          provider: result.provider,
          estimated: result.estimated,
          trimmed: result.trimmed,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return fail(errorMessage(err));
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close().catch(() => undefined);
    }
  });
  return app;
}
