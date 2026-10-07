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
  it("opens loopback and replies first, then decides every destination by the first matching rule", async () => {
    const { guardRules } = await load();
    const rules = guardRules(BASE);
    expect(rules[0]).toEqual(["-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"]);
    expect(rules[1]).toEqual([
      "-A",
      "OUTPUT",
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "ACCEPT",
    ]);
    const decide = (ip: string, port = 0) => {
      const rule = firstFor(rules, ip, inCidr4, port);
      return rule === undefined ? "ACCEPT" : verdict(rule);
    };
    // Open: the task's own network, majhi on its one port, public addresses.
    expect(decide("192.168.166.2", 5432)).toBe("ACCEPT");
    expect(decide("192.168.165.2", 7070)).toBe("ACCEPT");
    expect(decide("1.1.1.1", 443)).toBe("ACCEPT");
    expect(decide("172.32.0.1", 443)).toBe("ACCEPT");
    // Refused: majhi on any other port, a peer runner, another task's network, the computer, the gateways.
    expect(decide("192.168.165.2", 8080)).toBe("REJECT");
    expect(decide("192.168.165.3", 7070)).toBe("REJECT");
    expect(decide("192.168.167.2", 5432)).toBe("REJECT");
    expect(decide("0.250.250.254", 7070)).toBe("REJECT");
    expect(decide("192.168.165.1", 7070)).toBe("REJECT");
    expect(decide("192.168.166.1", 5432)).toBe("REJECT");
  });

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

  it("never lets a subnet or a name server override a refused host address", async () => {
    const { guardRules } = await load();
    const rules = guardRules({ ...BASE, allow: ["192.168.165.0/24"], dns: ["192.168.165.1"] });
    const gateway = firstFor(rules, "192.168.165.1", inCidr4, 53);
    expect(gateway && verdict(gateway)).toBe("REJECT");
  });

  it("ignores a subnet or server address that is not IPv4", async () => {
    const { guardRules } = await load();
    const rules = guardRules({
      ...BASE,
      allow: ["fd00::/8", "not a subnet", "10.0.0.0/4"],
      server: { address: "x", port: 1 },
    });
    expect(
      rules
        .filter((r) => verdict(r) === "ACCEPT")
        .map(dest)
        .filter(Boolean),
    ).not.toContain("fd00::/8");
    expect(rules.some((r) => dest(r) === "10.0.0.0/4")).toBe(false);
  });

  it("filters IPv6 the same way: loopback, replies, public open; unique local, link-local, mapped and the host's refused", async () => {
    const { guardRules6 } = await load();
    const rules = guardRules6({ hostAddresses: ["fd07:b51a:cc66:f0::fe", "192.0.2.1"], dns: ["fd00::53"] });
    expect(rules[0]).toEqual(["-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"]);
    const rejected = rules.filter((r) => verdict(r) === "REJECT").map(dest);
    expect(rejected).toEqual(["fd07:b51a:cc66:f0::fe/128", "fc00::/7", "fe80::/10", "::ffff:0:0/96"]);
    // Nothing opens a private IPv6 range except a name server on port 53.
    const opened = rules.filter((r) => verdict(r) === "ACCEPT" && dest(r) !== undefined);
    expect(opened.every((r) => r.includes("53"))).toBe(true);
  });

  it("reads name servers from resolv.conf and the upstream Docker notes", async () => {
    const { nameServers } = await load();
    const text = ["nameserver 127.0.0.11", "# ExtServers: [host(0.250.250.200) host(8.8.8.8)]"].join("\n");
    expect(nameServers(text)).toEqual(["127.0.0.11", "0.250.250.200", "8.8.8.8"]);
  });

  it("takes only IPv4 subnets and one server from the arguments, up to the run's own", async () => {
    const { parseArgs } = await load();
    expect(
      parseArgs([
        "--allow",
        "192.168.166.0/24",
        "--server",
        "majhi-server:7070",
        "--",
        "claude",
        "--allow",
        "x",
      ]),
    ).toEqual({
      allow: ["192.168.166.0/24"],
      server: { host: "majhi-server", port: 7070 },
      refresh: false,
      hold: false,
    });
    expect(() => parseArgs(["--allow", "10.0.0.0/4"])).toThrow();
    expect(() => parseArgs(["--allow", "fd00::/8"])).toThrow();
    expect(() => parseArgs(["--server", "majhi-server:0"])).toThrow();
    expect(() => parseArgs(["--other"])).toThrow();
  });

  it("reads gateways from the kernel route table", async () => {
    const { routeGateways } = await load();
    const table = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
      "eth0\t00000000\t01A5A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
      "eth0\t00A5A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
    ].join("\n");
    expect(routeGateways(table)).toEqual(["192.168.165.1"]);
  });
});
