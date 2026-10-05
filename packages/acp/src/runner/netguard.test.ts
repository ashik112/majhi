import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The guard runs inside the runner image as plain Node, so it lives beside the Dockerfile.
const GUARD = join(import.meta.dirname, "..", "..", "..", "..", "docker", "netguard.mjs");

interface Guard {
  guardRules(input: {
    ifaces: { address: string; netmask: string }[];
    gateways: string[];
    hostAddresses: string[];
  }): string[][];
  routeGateways(table: string): string[];
}

const load = async () => (await import(GUARD)) as Guard;
const destinations = (rules: string[][]) => rules.flatMap((r) => (r[2] === "-d" ? [r[3]] : []));

describe("network guard rules", () => {
  it("rejects the host's addresses, every gateway and the magic ranges, and lets loopback through first", async () => {
    const { guardRules } = await load();
    const rules = guardRules({
      ifaces: [
        { address: "192.168.165.7", netmask: "255.255.255.0" },
        { address: "10.20.30.4", netmask: "255.255.0.0" },
      ],
      gateways: ["192.168.165.1"],
      hostAddresses: ["0.250.250.254"],
    });
    expect(rules[0]).toEqual(["-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"]);
    expect(destinations(rules)).toEqual([
      "0.250.250.254/32",
      "10.20.0.1/32",
      "192.168.165.1/32",
      "0.0.0.0/8",
      "169.254.0.0/16",
    ]);
    expect(rules.slice(1).every((r) => r.at(-1) === "REJECT")).toBe(true);
  });

  it("leaves the container's own network and the internet open", async () => {
    const { guardRules } = await load();
    const rules = guardRules({
      ifaces: [{ address: "192.168.165.7", netmask: "255.255.255.0" }],
      gateways: [],
      hostAddresses: [],
    });
    expect(destinations(rules)).not.toContain("192.168.165.0/24");
    expect(rules.some((r) => r.includes("DROP"))).toBe(false);
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
