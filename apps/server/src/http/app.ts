import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type ApiError, COMMAND_META_HEADER, type Health } from "@majhi/shared";
import { Hono } from "hono";
import type { Dispatch } from "../commands/dispatch.ts";
import { errorMessage } from "../errors.ts";
import { type HostRoutesDeps, hostRoutes } from "../host/routes.ts";

export interface AppDeps {
  version: string;
  /** Built web app. When it has no index.html, `/` explains that instead. */
  webDist: string;
  dispatch: Dispatch;
  /** The host helper link, served at `/api/host`. */
  host: HostRoutesDeps;
}

const NOT_BUILT =
  "majhi is running, but the web app is not built.\n" +
  "Run `pnpm build`, or run `pnpm dev` and open the Vite URL.\n";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", version: deps.version } satisfies Health));

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
    const result = await deps.dispatch(c.req.param("name"), input, c.req.header(COMMAND_META_HEADER));
    return result.ok ? c.json(result.output) : c.json(result.error, result.status);
  });

  app.route("/api/host", hostRoutes(deps.host));

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

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}
