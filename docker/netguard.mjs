#!/usr/bin/env node
// Runs first in every runner container, and in the holder of every preview (SPEC 6), as root with only
// the capabilities it needs. It closes a container's reach to everything private, then majhi-netguard
// drops to the owner's uid with no capabilities and starts the run. The rules come from guardRules()
// and guardRules6(), tested in packages/acp/src/runner/netguard.test.ts.
//
// Default deny for private destinations. Open: loopback, replies to connections that came in (the
// owner's browser to a preview), the whole public internet (IPv4 and IPv6), the container's own task
// network (--allow, given by majhi), majhi-server on the one port the guarded path uses (--server),
// and the DNS servers the runtime gave. Refused: the addresses the host's names resolve to and every
// gateway (the computer itself), then 0/8, 10/8, 100.64/10, 169.254/16, 172.16/12 and 192.168/16
// (this includes other tasks' networks, peer runners on the shared runner network, and the owner's
// LAN and VPN), and for IPv6 fc00::/7, fe80::/10, mapped IPv4 and the host's addresses.
//
// Usage: netguard.mjs [--allow <cidr>]... [--server <host>:<port>] [--refresh | --hold] [-- ...]
//   --refresh  sets the rules again with the given --allow list (a network joined later), then exits
//   --hold     sets the rules, then waits forever: the holder of a preview shares its network with it

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
const IPTABLES_RESTORE = "/usr/sbin/iptables-restore";
const IP6TABLES_RESTORE = "/usr/sbin/ip6tables-restore";
/** Every private or special IPv4 range. A destination in none of them is public. */
export const PRIVATE_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
];
/** Unique local, link-local and the IPv4-mapped form (a mapped private address is still private). */
export const PRIVATE_RANGES_6 = ["fc00::/7", "fe80::/10", "::ffff:0:0/96"];

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

/** An IPv4 subnet as `a.b.c.d/n` with a prefix of 8 to 32, or undefined. */
export function cidr4(text) {
  const [address, bits, ...more] = String(text).split("/");
  const prefix = Number(bits);
  if (more.length > 0 || ipv4(address) === undefined || bits === undefined || bits === "") return undefined;
  if (!Number.isInteger(prefix) || String(prefix) !== bits || prefix < 8 || prefix > 32) return undefined;
  return `${address}/${bits}`;
}

/**
 * The IPv4 iptables rules (each a list of arguments) for one container. `ifaces` are its
 * addresses with netmasks, `gateways` the routers in its route table, `hostAddresses` what the
 * host's names resolve to, `allow` the subnets of its own task network, `server` majhi-server's
 * address and port, `dns` the name servers the runtime gave. Pure: nothing here reads the container.
 */
export function guardRules({ ifaces, gateways, hostAddresses, allow = [], server, dns = [] }) {
  const blocked = new Set();
  for (const g of gateways) if (ipv4(g) !== undefined) blocked.add(g);
  for (const i of ifaces) {
    const first = firstHost(i.address, i.netmask);
    if (first !== undefined) blocked.add(first);
  }
  for (const h of hostAddresses) if (ipv4(h) !== undefined) blocked.add(h);
  const reject = (dest) => ["-A", "OUTPUT", "-d", dest, "-j", "REJECT"];
  const accept = (dest, extra = []) => ["-A", "OUTPUT", "-d", dest, ...extra, "-j", "ACCEPT"];
  const opened = [];
  for (const d of dns) {
    if (ipv4(d) === undefined || blocked.has(d)) continue;
    for (const proto of ["udp", "tcp"]) opened.push(accept(`${d}/32`, ["-p", proto, "--dport", "53"]));
  }
  if (server !== undefined && ipv4(server.address) !== undefined && !blocked.has(server.address)) {
    opened.push(accept(`${server.address}/32`, ["-p", "tcp", "--dport", String(server.port)]));
  }
  for (const c of allow) {
    const ok = cidr4(c);
    if (ok !== undefined) opened.push(accept(ok));
  }
  return [
    ["-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"],
    ["-A", "OUTPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    ...[...blocked].sort().map((a) => reject(`${a}/32`)),
    ...opened,
    ...PRIVATE_RANGES.map(reject),
  ];
}

/** The IPv6 rules: loopback, replies, neighbour discovery and the public internet stay open. */
export function guardRules6({ hostAddresses = [], dns = [] }) {
  const reject = (dest) => ["-A", "OUTPUT", "-d", dest, "-j", "REJECT"];
  const hosts = [...new Set(hostAddresses.filter((a) => String(a).includes(":")))].sort();
  const resolvers = dns.filter((a) => String(a).includes(":") && !hosts.includes(a));
  return [
    ["-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"],
    ["-A", "OUTPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    ...["133", "134", "135", "136"].map((t) => [
      "-A",
      "OUTPUT",
      "-p",
      "ipv6-icmp",
      "--icmpv6-type",
      t,
      "-j",
      "ACCEPT",
    ]),
    ...hosts.map((a) => reject(`${a}/128`)),
    ...resolvers.flatMap((a) =>
      ["udp", "tcp"].map((p) => ["-A", "OUTPUT", "-d", `${a}/128`, "-p", p, "--dport", "53", "-j", "ACCEPT"]),
    ),
    ...PRIVATE_RANGES_6.map(reject),
  ];
}

/** The text `iptables-restore` takes: the filter table with exactly these OUTPUT rules, swapped in at once. */
export function restoreText(rules) {
  const head = "*filter\n:INPUT ACCEPT [0:0]\n:FORWARD ACCEPT [0:0]\n:OUTPUT ACCEPT [0:0]\n";
  return `${head}${rules.map((r) => r.join(" ")).join("\n")}\nCOMMIT\n`;
}

/** The name servers a container's runtime set: its resolv.conf, and the upstream Docker noted in a comment. */
export function nameServers(text) {
  const found = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("nameserver ")) found.add(line.slice(11).trim());
    const at = line.indexOf("ExtServers: [");
    if (at === -1) continue;
    for (const entry of (line.slice(at + 13).split("]")[0] ?? "").split(" ")) {
      const open = entry.indexOf("(");
      if (open !== -1 && entry.endsWith(")")) found.add(entry.slice(open + 1, -1));
    }
  }
  return [...found];
}

/** `--allow`, `--server`, `--refresh` and `--hold` from the arguments, up to a `--`. */
export function parseArgs(argv) {
  const out = { allow: [], server: undefined, refresh: false, hold: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === "--allow") {
      const c = cidr4(argv[++i] ?? "");
      if (c === undefined) throw new Error("--allow needs an IPv4 subnet like 192.168.0.0/24");
      out.allow.push(c);
    } else if (a === "--server") {
      const text = argv[++i] ?? "";
      const at = text.lastIndexOf(":");
      const port = Number(text.slice(at + 1));
      if (at < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("--server needs host:port");
      }
      out.server = { host: text.slice(0, at), port };
    } else if (a === "--refresh") out.refresh = true;
    else if (a === "--hold") out.hold = true;
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

async function resolveNames(names, family) {
  const found = [];
  for (const name of names) {
    try {
      for (const r of await lookup(name, { all: true, family })) found.push(r.address);
    } catch {
      // The runtime does not know this name.
    }
  }
  return found;
}

/** True when the container has an IPv6 address besides loopback. */
function hasGlobal6() {
  return Object.values(networkInterfaces())
    .flat()
    .some((i) => i !== undefined && i.family === "IPv6" && !i.internal);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ifaces = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i !== undefined && i.family === "IPv4" && !i.internal)
    .map((i) => ({ address: i.address, netmask: i.netmask }));
  let server;
  if (opts.server !== undefined) {
    const [address] = await resolveNames([opts.server.host], 4);
    if (address === undefined) throw new Error(`${opts.server.host} does not resolve`);
    server = { address, port: opts.server.port };
  }
  const resolv = nameServers(readFileSync("/etc/resolv.conf", "utf8"));
  const rules = guardRules({
    ifaces,
    gateways: routeGateways(readFileSync("/proc/net/route", "utf8")),
    hostAddresses: await resolveNames(HOST_NAMES, 4),
    allow: opts.allow,
    server,
    dns: resolv,
  });
  execFileSync(IPTABLES_RESTORE, ["-w"], {
    input: restoreText(rules),
    stdio: ["pipe", "inherit", "inherit"],
  });
  const rules6 = guardRules6({ hostAddresses: await resolveNames(HOST_NAMES, 6), dns: resolv });
  try {
    execFileSync(IP6TABLES_RESTORE, ["-w"], {
      input: restoreText(rules6),
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (err) {
    // A kernel without IPv6 filtering has nothing to filter, unless the container has an IPv6 address.
    if (hasGlobal6()) throw err;
  }
  if (opts.hold) {
    process.stdout.write("majhi-netguard ready\n");
    setInterval(() => undefined, 2 ** 30);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    process.stderr.write(`majhi could not close this container's route to private networks: ${why}\n`);
    process.exit(1);
  }
}
