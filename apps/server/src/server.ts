import type { Hono } from "hono";
import { createDispatcher } from "./commands/dispatch.ts";
import { createHandlers } from "./commands/handlers.ts";
import { ConfigService } from "./config/service.ts";
import type { ServerEnv } from "./env.ts";
import { createApp } from "./http/app.ts";
import { RepoScanner } from "./scan/scanner.ts";

/** Wires the config, the scanner and the commands into the HTTP app. */
export function createMajhiApp(env: ServerEnv): Hono {
  const config = new ConfigService({ majhiHome: env.majhiHome, hostHome: env.hostHome });
  const dispatch = createDispatcher(createHandlers({ config, scanner: new RepoScanner() }));
  return createApp({ version: env.version, webDist: env.webDist, dispatch });
}
