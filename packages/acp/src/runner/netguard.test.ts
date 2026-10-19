import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The guard runs inside the runner image as plain Node, so it lives beside the Dockerfile.
const GUARD = join(import.meta.dirname, "..", "..", "..", "..", "docker", "netguard.mjs");

type Rule = string[];

interface Guard {
  guardRules(input: {
    ifaces: { address: string; netmask: string }[];
    gateways: string[];
    hostAddresses: string[];
    allow?: string[];
    server?: { address: string; port: number } | undefined;
    dns?: string[];
  }): Rule[];
  guardRules6(input: { hostAddresses?: string[]; dns?: string[] }): Rule[];
  routeGateways(table: string): string[];
  nameServers(text: string): string[];
  parseArgs(argv: string[]): { allow: string[]; server?: { host: string; port: number }; hold: boolean };
  restoreText(rules: Rule[]): string;
}

const load = async () => (await import(GUARD)) as Guard;
const verdict = (r: Rule) => r.at(-1);
const dest = (r: Rule) => (r.includes("-d") ? r[r.indexOf("-d") + 1] : undefined);
/** Index of the first rule that matches a destination: how the kernel would decide, in order. */
const firstFor = (rules: Rule[], ip: string, inRange: (cidr: string, ip: string) => boolean, port = 0) =>
  rules.find((r) => {
    if (r.includes("-o")) return false;
    if (r.includes("conntrack")) return false;
    const d = dest(r);
    if (d === undefined) return false;
    const p = r.indexOf("--dport");
    if (p !== -1 && Number(r[p + 1]) !== port) return false;
    return inRange(d, ip);
  });

const inCidr4 = (cidr: string, ip: string) => {
  const num = (a: string) => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
  const [base = "", bits = "32"] = cidr.split("/");
  const mask = bits === "0" ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return (num(base) & mask) >>> 0 === (num(ip) & mask) >>> 0;
};

const BASE = {
  ifaces: [
    { address: "192.168.165.7", netmask: "255.255.255.0" },
    { address: "192.168.166.7", netmask: "255.255.255.0" },
  ],
  gateways: ["192.168.165.1"],
  hostAddresses: ["0.250.250.254"],
  allow: ["192.168.166.0/24"],
  server: { address: "192.168.165.2", port: 7070 },
  dns: ["127.0.0.11", "0.250.250.200"],
};

describe("network guard rules", () => {
  it("refuses every private range, the LAN, the VPN and link-local ones included", async () => {
    const { guardRules } = await load();
    const rules = guardRules({ ...BASE, allow: [], server: undefined });
    for (const ip of [
      "10.1.2.3",
      "172.16.0.9",
      "172.31.255.255",
      "192.168.1.20",
      "100.64.0.5",
      "169.254.169.254",
      "0.1.2.3",
    ]) {
      const rule = firstFor(rules, ip, inCidr4, 443);
      expect(rule === undefined ? "ACCEPT" : verdict(rule), ip).toBe("REJECT");
    }
  });
});
