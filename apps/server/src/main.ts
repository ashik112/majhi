import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { prepareStart } from "./backup/boot.ts";
import { parseEnv, type ServerEnv } from "./env.ts";
import { errorMessage } from "./errors.ts";
import { HostLink } from "./host/link.ts";
import { createMajhi } from "./server.ts";
import { removeLeftoverFolders } from "./system/removed-folders.ts";

const SHUTDOWN_GRACE_MS = 5_000;

let env: ServerEnv;
try {
  env = parseEnv();
} catch (err) {
  console.error(errorMessage(err));
  process.exit(1);
}

if (env.runner.mode === "local") {
  console.warn(
    "majhi: MAJHI_RUNNER=local. Agents run next to majhi, with its access to files and git, not in a runner container per run. Use it only for tests and development.",
  );
}

// A staged restore is swapped in, and a database about to be migrated is backed up, before any file opens.
await prepareStart(env);
// Folders of removed features (the old e2e runner) are taken off the disk, in the background.
void removeLeftoverFolders(env.majhiHome).catch(() => undefined);

const hostLink = new HostLink();
const majhi = createMajhi(env, { hostLink });
const server = serve({ fetch: majhi.app.fetch, hostname: env.host, port: env.port, createServer }, (info) => {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  // Runner containers reach majhi by its name on their network; agents run here reach it on loopback.
  majhi.services.adminTokens.mcpUrl =
    env.runner.mode === "container"
      ? `http://${env.runner.mcpHost}:${info.port}/mcp`
      : `http://127.0.0.1:${info.port}/mcp`;
  console.log(`majhi ${env.version} listening on http://${host}:${info.port}`);
});
majhi.attach(server);

server.on("error", (err) => {
  console.error(`majhi could not start: ${errorMessage(err)}`);
  process.exit(1);
});

function shutdown(signal: string): void {
  console.log(`majhi stopping (${signal})`);
  // The host helper's long poll would hold close() open for up to 25 seconds.
  hostLink.close();
  const closed = majhi.close();
  // Open keep-alive connections would hold close() open. Give requests a moment, then force.
  const force = setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  force.unref();
  // Agent processes are ended before we exit.
  server.close(() => void closed.finally(() => process.exit(0)));
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
