#!/usr/bin/env node
// Runs first in every runner container, as root, with only the capabilities it needs (SPEC 6). It
// closes the ways a container can reach services on the owner's own computer, then majhi-netguard
// drops to the owner's uid with no capabilities and starts the run. The rules come from
// guardRules(), tested in packages/acp/src/runner/netguard.test.ts.
//
// Blocked: the addresses the host answers on for a container (host.docker.internal and its
// siblings, which is how a container reaches a service bound to the computer's own 127.0.0.1,
// majhi's API port included), the gateway of every network the container is on, OrbStack's and
// Docker Desktop's magic range 0.0.0.0/8, and link-local 169.254.0.0/16 (cloud metadata).
// Everything else, the internet, majhi's own address and the task's services, is reachable.

import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";

/** Names a container's runtime gives the computer it runs on. */
export const HOST_NAMES = [
  "host.docker.internal",
  "host.orb.internal",
  "host.internal",
  "gateway.docker.internal",
  "host.containers.internal",
];

/** By path: a run's PATH is its own, and iptables lives in sbin. */
const IPTABLES = "/usr/sbin/iptables";
const BLOCKED_RANGES = ["0.0.0.0/8", "169.254.0.0/16"];

/** A dotted IPv4 address as a number, or undefined when it is not exactly four octets. */
function ipv4(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (p === "" || !Number.isInteger(v) || v < 0 || v > 255 || String(v) !== p) return undefined;
    n = n * 256 + v;
  }
  return n;
}

function dotted(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** The first host address of the subnet an interface address is in: where Docker puts the gateway. */
export function firstHost(address, netmask) {
  const a = ipv4(address);
  const m = ipv4(netmask);
  if (a === undefined || m === undefined) return undefined;
  return dotted((((a & m) >>> 0) + 1) >>> 0);
}

/** Gateways from the kernel's route table text (/proc/net/route): little-endian hex, 0 means none. */
export function routeGateways(table) {
  const out = [];
  for (const line of table.split("\n").slice(1)) {
    const hex = line.split("\t")[2];
    if (hex === undefined || hex.length !== 8 || hex === "00000000") continue;
    const n = Number.parseInt(hex, 16);
    if (!Number.isInteger(n)) continue;
    out.push(
      dotted(
        ((n & 255) * 2 ** 24 + ((n >>> 8) & 255) * 2 ** 16 + ((n >>> 16) & 255) * 2 ** 8 + (n >>> 24)) >>> 0,
      ),
    );
  }
  return out;
}

/**
 * The iptables rules (each a list of arguments) for one container. `ifaces` are its IPv4
 * addresses with netmasks, `gateways` the routers in its route table, `hostAddresses` what the
 * host's names resolve to. Pure: nothing here reads the container.
 */
export function guardRules({ ifaces, gateways, hostAddresses }) {
  const blocked = new Set();
  for (const g of gateways) if (ipv4(g) !== undefined) blocked.add(g);
  for (const i of ifaces) {
    const first = firstHost(i.address, i.netmask);
    if (first !== undefined) blocked.add(first);
  }
  for (const h of hostAddresses) if (ipv4(h) !== undefined) blocked.add(h);
  const reject = (dest) => ["-A", "OUTPUT", "-d", dest, "-j", "REJECT"];
  return [
    ["-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"],
    ...[...blocked].sort().map((a) => reject(`${a}/32`)),
    ...BLOCKED_RANGES.map(reject),
  ];
}

async function resolveHosts() {
  const found = [];
  for (const name of HOST_NAMES) {
    try {
      for (const r of await lookup(name, { all: true, family: 4 })) found.push(r.address);
    } catch {
      // The runtime does not know this name.
    }
  }
  return found;
}

async function main() {
  const ifaces = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i !== undefined && i.family === "IPv4" && !i.internal)
    .map((i) => ({ address: i.address, netmask: i.netmask }));
  const rules = guardRules({
    ifaces,
    gateways: routeGateways(readFileSync("/proc/net/route", "utf8")),
    hostAddresses: await resolveHosts(),
  });
  for (const rule of rules) execFileSync(IPTABLES, ["-w", ...rule], { stdio: "inherit" });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    process.stderr.write(`majhi could not close this container's route to the computer: ${why}\n`);
    process.exit(1);
  }
}
