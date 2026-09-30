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
    "Ask a small, fast classifier typed questions about some text and get answers with probabilities. " +
    "It reads, it does not reason or write: use it for quick classification, not for judgment calls that need thought. " +
    "Best results: give the state as named fields ({ message, file }) and refer to them by name in the question; " +
    "give each choice option a short key and a description ({ key: 'small', description: 'a one-file change' }); " +
    "keep to 2 to 8 options; never use yes or no as keys. For a yes/no question use a choice with keys A and B, " +
    "each described, and orders 'reversed' (asked in both orders, averaged). " +
    "A choice gets the option 'none: none of these fits' unless abstain is false; an answer of none means it could not tell. " +
    "Each answer has a gate: act on it only when gate.accepted is true, else decide yourself. " +
    "Question types: choice, score (an integer from min to max), noul (true or false, with criteria describing each). " +
    "The state and question share a window of about 500 tokens; `trimmed` says when the state was cut.",
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
