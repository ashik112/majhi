import { serve } from "@hono/node-server";
import { parseEnv, type ServerEnv } from "./env.ts";
import { errorMessage } from "./errors.ts";
import { createMajhiApp } from "./server.ts";

const SHUTDOWN_GRACE_MS = 5_000;

let env: ServerEnv;
try {
  env = parseEnv();
} catch (err) {
  console.error(errorMessage(err));
  process.exit(1);
}

const server = serve({ fetch: createMajhiApp(env).fetch, hostname: env.host, port: env.port }, (info) => {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  console.log(`majhi ${env.version} listening on http://${host}:${info.port}`);
});

server.on("error", (err) => {
  console.error(`majhi could not start: ${errorMessage(err)}`);
  process.exit(1);
});

function shutdown(signal: string): void {
  console.log(`majhi stopping (${signal})`);
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
