import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type ApiError, COMMAND_META_HEADER, type Health } from "@majhi/shared";
import { Hono } from "hono";
import { mcpRoutes } from "../admin/mcp.ts";
import type { AdminService } from "../admin/service.ts";
import type { AdminTokens } from "../admin/tokens.ts";
import type { Dispatch } from "../commands/dispatch.ts";
import { connectRoutes } from "../connect/routes.ts";
import type { ConnectService } from "../connect/service.ts";
import { type DecideMcpDeps, decideMcpRoutes } from "../decisions/mcp.ts";
import { errorMessage } from "../errors.ts";
import { type HostRoutesDeps, hostRoutes } from "../host/routes.ts";
import { type RoomMcpDeps, roomMcpRoutes } from "../rooms/mcp.ts";
import { uploadRoutes } from "../uploads/routes.ts";
import type { UploadStore } from "../uploads/store.ts";
import { isLoopbackOrigin } from "./origin.ts";
import { type TaskFilesDeps, taskFileRoutes } from "./taskFiles.ts";

export interface AppDeps {
  version: string;
  /** Git commit the image was built from. `/health` reports it so a browser can tell a new server from the old one. */
  commit?: string;
  /** Built web app. When it has no index.html, `/` explains that instead. */
  webDist: string;
  dispatch: Dispatch;
  /** The host helper link, served at `/api/host`. */
  host: HostRoutesDeps;
  /** Serves `POST /api/uploads`. */
  uploads: UploadStore;
  /** Serves `GET /api/tasks/<id>/files/<path>`. */
  taskFiles: TaskFilesDeps;
  /** `GET /oauth/callback`, where services send the owner back after Connect's consent page. */
  connect?: ConnectService;
  /** The majhi-admin MCP server at `/mcp`. */
  mcp?: { tokens: AdminTokens; admin: AdminService };
  /** The majhi-decide MCP server at `/mcp/decide`. */
  decideMcp?: DecideMcpDeps;
  /** majhi-room at `/mcp/room` and majhi-tasks at `/mcp/tasks`. */
  roomMcp?: RoomMcpDeps;
  /** True for a request from an agent's runner container: it may reach only `/mcp` (Phase 2c). */
  isRunner?: (remoteAddress: string | undefined) => boolean;
}

const NOT_BUILT =
  "majhi is running, but the web app is not built.\n" +
  "Run `pnpm build`, or run `pnpm dev` and open the Vite URL.\n";

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Agent runs share a network with majhi so they can reach their MCP tools. Everything else,
  // the commands above all, answers only the owner.
  const isRunner = deps.isRunner;
  if (isRunner !== undefined) {
    app.use("*", async (c, next) => {
      const path = c.req.path;
      if (isRunner(remoteAddress(c.env)) && path !== "/mcp" && !path.startsWith("/mcp/")) {
        return c.json({ error: "Agent runs can only reach majhi's MCP tools" } satisfies ApiError, 403);
      }
      await next();
    });
  }

  app.get("/health", (c) =>
    c.json({ status: "ok", version: deps.version, commit: deps.commit ?? "dev" } satisfies Health),
  );

  app.post("/api/cmd/:name", async (c) => {
    // Browsers send Origin on cross-site POSTs. Only pages served from this
    // machine may run commands, so a website cannot change the config.
    const origin = c.req.header("origin");
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return c.json({ error: "Commands only run from majhi's own pages" } satisfies ApiError, 403);
    }
    const body = await c.req.text();
    let input: unknown = {};
    if (body.trim() !== "") {
      try {
        input = JSON.parse(body);
      } catch {
        return c.json({ error: "The request body is not valid JSON" } satisfies ApiError, 400);
      }
    }
    const result = await deps.dispatch(
      c.req.param("name"),
      input,
      withoutTask(c.req.header(COMMAND_META_HEADER)),
    );
    return result.ok ? c.json(result.output) : c.json(result.error, result.status);
  });

  if (deps.connect !== undefined) app.route("/", connectRoutes(deps.connect));
  if (deps.mcp !== undefined) app.route("/", mcpRoutes(deps.mcp));
  if (deps.decideMcp !== undefined) app.route("/", decideMcpRoutes(deps.decideMcp));
  if (deps.roomMcp !== undefined) app.route("/", roomMcpRoutes(deps.roomMcp));
  app.route("/api/host", hostRoutes(deps.host));
  app.route("/api/uploads", uploadRoutes(deps.uploads));
  app.route("/api/tasks", taskFileRoutes(deps.taskFiles));

  app.all("/api/*", (c) =>
    c.json({ error: `Not found: ${c.req.method} ${c.req.path}` } satisfies ApiError, 404),
  );

  const index = join(deps.webDist, "index.html");
  if (existsSync(index)) {
    const serveIndex = serveStatic({ path: index });
    app.get("*", serveStatic({ root: deps.webDist }));
    // Client-side routes get the app. Missing files, like `/assets/old.js`, stay 404.
    app.get("*", (c, next) => (/\.[a-z0-9]+$/i.test(c.req.path) ? next() : serveIndex(c, next)));
  } else {
    app.get("*", (c) => c.text(NOT_BUILT));
  }

  app.notFound((c) => c.json({ error: `Not found: ${c.req.method} ${c.req.path}` } satisfies ApiError, 404));
  app.onError((err, c) => c.json({ error: errorMessage(err) } satisfies ApiError, 500));
  return app;
}

export { isLoopbackOrigin };

/** The peer address of a request served by @hono/node-server; undefined in tests that call `app.request`. */
function remoteAddress(env: unknown): string | undefined {
  if (typeof env !== "object" || env === null) return undefined;
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: unknown } } }).incoming;
  const address = incoming?.socket?.remoteAddress;
  return typeof address === "string" ? address : undefined;
}

/**
 * The meta header without a `task`. Only majhi sets the calling task, on the MCP and admin paths,
 * so a call over HTTP has none and cannot attach files by path.
 */
export function withoutTask(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  try {
    const meta: unknown = JSON.parse(header);
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return header;
    const { task: _task, ...rest } = meta as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return header;
  }
}
