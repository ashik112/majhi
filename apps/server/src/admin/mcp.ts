import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { isLoopbackOrigin } from "../http/origin.ts";
import type { AdminService } from "./service.ts";
import { type AdminCaller, type AdminTokens, bearerOf } from "./tokens.ts";
import { adminTools } from "./tools.ts";

export const MCP_PATH = "/mcp";

const TOOLS = adminTools().map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

/** A fresh MCP server for one request, bound to the agent that made it. */
function serverFor(caller: AdminCaller, admin: AdminService): Server {
  const server = new Server({ name: "majhi-admin", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const result = await admin.call(caller, request.params.name, args);
    return { content: [{ type: "text" as const, text: result.text }], isError: result.isError };
  });
  return server;
}

/**
 * `/mcp`: the majhi-admin MCP server over streamable HTTP, stateless (one server per request,
 * JSON answers). Every request needs the bearer token the run manager issued to that agent
 * session. A browser page from another origin is refused, like the command endpoint.
 */
export function mcpRoutes(deps: { tokens: AdminTokens; admin: AdminService }): Hono {
  const app = new Hono();
  app.all(MCP_PATH, async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return c.json({ error: "majhi-admin is not for web pages" }, 403);
    }
    const token = bearerOf(c.req.header("authorization"));
    const caller = token === undefined ? undefined : deps.tokens.lookup(token);
    if (caller === undefined) {
      return c.json({ error: "A valid bearer token is required" }, 401, { "www-authenticate": "Bearer" });
    }
    const server = serverFor(caller, deps.admin);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      // The JSON answer is complete once handleRequest resolves.
      void server.close().catch(() => undefined);
    }
  });
  return app;
}
