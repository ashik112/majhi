import { serve } from "@hono/node-server";
import { parseEnv, type ServerEnv } from "./env.ts";
import { errorMessage } from "./errors.ts";
import { HostLink } from "./host/link.ts";
import { createMajhiApp } from "./server.ts";

const SHUTDOWN_GRACE_MS = 5_000;

let env: ServerEnv;
try {
  env = parseEnv();
} catch (err) {
  console.error(errorMessage(err));
  process.exit(1);
}

const hostLink = new HostLink();
const app = createMajhiApp(env, { hostLink });
const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  console.log(`majhi ${env.version} listening on http://${host}:${info.port}`);
});

server.on("error", (err) => {
  console.error(`majhi could not start: ${errorMessage(err)}`);
  process.exit(1);
});

function shutdown(signal: string): void {
  console.log(`majhi stopping (${signal})`);
  // The host helper's long poll would hold close() open for up to 25 seconds.
  hostLink.close();
  // Open keep-alive connections would hold close() open. Give requests a moment, then force.
  const force = setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  force.unref();
  server.close(() => process.exit(0));
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
