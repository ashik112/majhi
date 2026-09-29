import type { Hono } from "hono";
import { createDispatcher } from "./commands/dispatch.ts";
import { createHandlers } from "./commands/handlers.ts";
import { ConfigService } from "./config/service.ts";
import type { ServerEnv } from "./env.ts";
import { HostLink } from "./host/link.ts";
import { createApp } from "./http/app.ts";
import { RepoScanner } from "./scan/scanner.ts";

export interface MajhiAppOptions {
  /** Passed in by `main.ts` so shutdown can end the helper's poll, and by tests to shorten timeouts. */
  hostLink?: HostLink;
}

/** Wires the config, the scanner, the host helper link and the commands into the HTTP app. */
export function createMajhiApp(env: ServerEnv, options: MajhiAppOptions = {}): Hono {
  const hostLink = options.hostLink ?? new HostLink();
  const config = new ConfigService({ majhiHome: env.majhiHome, hostHome: env.hostHome });
  const dispatch = createDispatcher(createHandlers({ config, scanner: new RepoScanner(), hostLink }));
  return createApp({
    version: env.version,
    webDist: env.webDist,
    dispatch,
    host: { link: hostLink, majhiHome: env.majhiHome },
  });
}
