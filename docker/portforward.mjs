#!/usr/bin/env node
// The forwarder of a service on the owner's computer (SPEC 5.14).
// Usage: portforward.mjs --from <subnet> <port>...
// It listens on each port it is given and passes every connection from inside <subnet> (the task's
// own network) to the same port of the owner's computer, and does nothing else: no other port is
// opened, a peer outside the subnet is dropped (on some runtimes another task's runner can reach
// this container's address), and the only address it ever connects to is host.docker.internal.
// It runs in a container started by majhi (apps/server/src/containers/service.ts) with no
// capability but binding low ports and no mount.

import net from "node:net";
import { pathToFileURL } from "node:url";

const TARGET = "host.docker.internal";

function wholeNumber(text, min, max) {
  const n = Number(text);
  return text !== "" && Number.isInteger(n) && String(n) === text && n >= min && n <= max ? n : undefined;
}

function ipv4(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    const v = wholeNumber(p, 0, 255);
    if (v === undefined) return undefined;
    n = n * 256 + v;
  }
  return n;
}

/** The subnet as an address and a mask, or undefined when it is not `a.b.c.d/n`. */
export function parseSubnet(text) {
  const [address, bits, ...rest] = String(text).split("/");
  const base = ipv4(address);
  const prefix = wholeNumber(bits ?? "", 8, 32);
  if (rest.length > 0 || base === undefined || prefix === undefined) return undefined;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

/**
 * True when `address` (IPv4, or IPv4 mapped into IPv6) is a peer inside the subnet. Not the first address, the
 * network's gateway: traffic that crossed in from another network (OrbStack routes it) arrives from there.
 */
export function inside(subnet, address) {
  const plain = String(address).startsWith("::ffff:") ? String(address).slice(7) : String(address);
  const ip = ipv4(plain);
  return ip !== undefined && (ip & subnet.mask) >>> 0 === subnet.base && ip !== subnet.base + 1;
}

function main() {
  const args = process.argv.slice(2);
  const subnet = args[0] === "--from" ? parseSubnet(args[1]) : undefined;
  const ports = args.slice(2).map((p) => wholeNumber(p, 1, 65535));
  if (subnet === undefined || ports.length === 0 || ports.some((p) => p === undefined)) {
    process.stderr.write("usage: portforward.mjs --from <subnet> <port>...\n");
    process.exit(2);
  }
  for (const port of new Set(ports)) {
    const server = net.createServer((client) => {
      if (!inside(subnet, client.remoteAddress)) {
        client.destroy();
        return;
      }
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
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
