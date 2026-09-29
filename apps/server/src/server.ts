import type { Hono } from "hono";
import { createDispatcher } from "./commands/dispatch.ts";
import { createHandlers } from "./commands/handlers.ts";
import type { ServerEnv } from "./env.ts";
import { topicsFor } from "./events/hub.ts";
import { HostLink } from "./host/link.ts";
import { createApp } from "./http/app.ts";
import { RepoScanner } from "./scan/scanner.ts";
import { createServices, type ServiceOptions, type Services } from "./services.ts";
import { attachSockets, type UpgradeSource } from "./sockets.ts";

export interface MajhiAppOptions extends ServiceOptions {
  /** Passed in by `main.ts` so shutdown can end the helper's poll, and by tests to shorten timeouts. */
  hostLink?: HostLink;
}

export interface Majhi {
  app: Hono;
  services: Services;
  /** Starts the file watcher and serves the WebSocket channels on `server`. */
  attach(server: UpgradeSource): void;
  /** Kills login terminals and stops the watcher and sockets. */
  close(): void;
}

/** Wires the config, accounts, agents, live channels, the host helper link and the commands together. */
export function createMajhi(env: ServerEnv, options: MajhiAppOptions = {}): Majhi {
  const hostLink = options.hostLink ?? new HostLink();
  const services = createServices(env, options);
  const config = services.config;
  const dispatch = createDispatcher(
    createHandlers({ config, scanner: new RepoScanner(), hostLink, services }),
    (name) => services.events.emit(topicsFor(name)),
  );
  const app = createApp({
    version: env.version,
    webDist: env.webDist,
    dispatch,
    host: { link: hostLink, majhiHome: env.majhiHome },
  });
  let sockets: { close: () => void } | undefined;
  return {
    app,
    services,
    attach(server) {
      services.watcher.start();
      services.usageSweeper.start();
      sockets = attachSockets(server, { events: services.events, terminals: services.terminals });
    },
    close() {
      services.watcher.stop();
      services.usageSweeper.stop();
      services.terminals.closeAll();
      sockets?.close();
    },
  };
}

/** The HTTP app alone, for tests that do not need sockets. */
export function createMajhiApp(env: ServerEnv, options: MajhiAppOptions = {}): Hono {
  return createMajhi(env, options).app;
}
