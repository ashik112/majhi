import { describe, expect, it } from "vitest";
import { inSubnet, parseSubnets, RunnerNetwork } from "./network.ts";

describe("inSubnet", () => {
  it("matches IPv4 and IPv4-mapped addresses", () => {
    expect(inSubnet("172.30.0.5", "172.30.0.0/16")).toBe(true);
    expect(inSubnet("::ffff:172.30.9.5", "172.30.0.0/16")).toBe(true);
    expect(inSubnet("172.31.0.5", "172.30.0.0/16")).toBe(false);
    expect(inSubnet("10.0.0.1", "0.0.0.0/0")).toBe(true);
    expect(inSubnet("::1", "172.30.0.0/16")).toBe(false);
    expect(inSubnet("not-an-ip", "172.30.0.0/16")).toBe(false);
  });
});

describe("RunnerNetwork", () => {
  it("tells runners apart, but never the gateway the owner's browser comes through", async () => {
    const net = new RunnerNetwork("majhi-runners", async () => parseSubnets("172.30.0.0/16|172.30.0.1 "));
    expect(net.isRunner("172.30.0.7")).toBe(false); // not known yet
    await net.ensure();
    expect(net.isRunner("172.30.0.7")).toBe(true);
    expect(net.isRunner("::ffff:172.30.0.7")).toBe(true);
    expect(net.isRunner("172.30.0.1")).toBe(false);
    expect(net.isRunner("172.18.0.1")).toBe(false);
    expect(net.isRunner("127.0.0.1")).toBe(false);
    expect(net.isRunner(undefined)).toBe(false);
  });

  it("refuses to be ready when Docker cannot say, and tries again next time", async () => {
    let calls = 0;
    const net = new RunnerNetwork("majhi-runners", async () => {
      calls++;
      if (calls === 1) throw new Error("Error: No such network: majhi-runners");
      return parseSubnets("172.30.0.0/16|172.30.0.1");
    });
    await expect(net.ensure()).rejects.toThrow();
    await net.ensure();
    expect(net.isRunner("172.30.4.4")).toBe(true);
  });
});
