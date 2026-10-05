#!/usr/bin/env node
// The forwarder of a service on the owner's computer (SPEC 5.14). Usage: portforward.mjs <port>...
// It listens on each port it is given and passes every connection to the same port of the owner's
// computer, and does nothing else: no other port is opened, and the only address it ever connects
// to is host.docker.internal. It runs in a container on the task's network, started by majhi
// (apps/server/src/containers/service.ts) with no capability but binding low ports and no mount.

import net from "node:net";

const TARGET = "host.docker.internal";

function portOf(text) {
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 && String(port) === text ? port : undefined;
}

const ports = process.argv.slice(2).map(portOf);
if (ports.length === 0 || ports.some((p) => p === undefined)) {
  process.stderr.write("usage: portforward.mjs <port>...\n");
  process.exit(2);
}

for (const port of new Set(ports)) {
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: TARGET, port });
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
  });
  server.on("error", (err) => {
    process.stderr.write(`port ${port}: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () => process.stdout.write(`forwarding ${port} to ${TARGET}:${port}\n`));
}
