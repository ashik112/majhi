import { join } from "node:path";
import { type CommandMeta, type ConnectionConfig, GLOBAL_CONNECTIONS, hostPortsIssue } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { runConnections } from "./access.ts";
import { planConnections } from "./plan.ts";
import { assertHostService } from "./service.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };
const AGENT: CommandMeta = { actor: { kind: "agent", id: "captain" } };

const northwind: ConnectionConfig = { type: "host", name: "Northwind", fields: { ports: "8000, 5432" } };
const orgs = {
  acme: { connections: { northwind } },
  globex: { connections: {} },
};
const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe("a service on this computer: ports", () => {
  it("refuses majhi's own port, a port out of range and anything that is not a port", () => {
    expect(hostPortsIssue("Ports", "8000, 5432")).toBeUndefined();
    expect(hostPortsIssue("Ports", "8000, 7070")).toContain("majhi's own");
    expect(hostPortsIssue("Ports", "0")).toContain("not a port");
    expect(hostPortsIssue("Ports", "65536")).toContain("not a port");
    expect(hostPortsIssue("Ports", "80a")).toContain("not a port");
    expect(hostPortsIssue("Ports", "0x50")).toContain("not a port");
    expect(hostPortsIssue("Ports", "")).toContain("at least one");
  });

  it("refuses the port the server really listens on, which can differ from the default", () => {
    expect(() => assertHostService({ org: "acme", ports: "9191" }, OWNER, [9191])).toThrow("majhi's own");
    expect(() => assertHostService({ org: "acme", ports: "8000" }, OWNER, [9191])).not.toThrow();
  });
});

describe("a service on this computer: who may grant it", () => {
  it("is the owner's alone: an agent or the captain is refused", () => {
    expect(() => assertHostService({ org: "acme", ports: "8000" }, AGENT, [])).toThrow("Only the owner");
    expect(() => assertHostService({ org: "acme", ports: undefined }, AGENT, [])).toThrow("Only the owner");
    expect(() => assertHostService({ org: "acme", ports: "8000" }, OWNER, [])).not.toThrow();
  });

  it("belongs to one workspace, never to Global", () => {
    expect(() => assertHostService({ org: GLOBAL_CONNECTIONS, ports: "8000" }, OWNER, [])).toThrow(
      "not to Global",
    );
  });
});

describe("a service on this computer: which tasks get it", () => {
  it("reaches only agents working in its own workspace", () => {
    const task = { org: "acme", connections: [] };
    expect(ids(runConnections({ agent: { id: "acme-dev", scope: "acme" }, task, orgs }))).toEqual([
      "northwind",
    ]);
    // Another workspace's task, and another workspace's agent in this one's task, get nothing.
    expect(
      runConnections({
        agent: { id: "globex-dev", scope: "globex" },
        task: { org: "globex", connections: [] },
        orgs,
      }),
    ).toEqual([]);
    expect(runConnections({ agent: { id: "globex-dev", scope: "globex" }, task, orgs })).toEqual([]);
    expect(
      runConnections({
        agent: { id: "acme-dev", scope: "acme" },
        task: { org: "globex", connections: ["northwind"] },
        orgs,
      }),
    ).toEqual([]);
  });

  it("reaches a root task only when the task names it", () => {
    const root = { id: "lead", scope: "root" };
    expect(ids(runConnections({ agent: root, task: { org: "globex", connections: [] }, orgs }))).toEqual([]);
    expect(ids(runConnections({ agent: root, task: { org: undefined, connections: [] }, orgs }))).toEqual([]);
    expect(
      ids(runConnections({ agent: root, task: { org: "globex", connections: ["northwind"] }, orgs })),
    ).toEqual(["northwind"]);
  });
});

describe("the forwarder's source check", () => {
  it("drops a peer outside the task's subnet, such as another task's runner", async () => {
    const path = join(import.meta.dirname, "..", "..", "..", "..", "docker", "portforward.mjs");
    const { parseSubnet, inside } = (await import(path)) as {
      parseSubnet(text: string): unknown;
      inside(subnet: unknown, address: string): boolean;
    };
    const task = parseSubnet("192.168.171.0/24");
    expect(inside(task, "192.168.171.9")).toBe(true);
    expect(inside(task, "::ffff:192.168.171.9")).toBe(true);
    // The gateway is where traffic from another network arrives: OrbStack routes it across.
    expect(inside(task, "192.168.171.1")).toBe(false);
    expect(inside(task, "192.168.172.9")).toBe(false);
    expect(inside(task, "192.168.165.4")).toBe(false);
    expect(inside(task, "not an address")).toBe(false);
    expect(parseSubnet("0.0.0.0/0")).toBeUndefined();
    expect(parseSubnet("192.168.171.0")).toBeUndefined();
  });
});

describe("a service on this computer: the run's plan", () => {
  const held = [{ id: "northwind", org: "acme", connection: northwind }];
  const deps = (connected: boolean) => ({
    secrets: { get: async () => undefined },
    connectionDir: (id: string) => `/tmp/${id}`,
    connected: () => connected,
  });

  it("offers it, with its name and ports, only while its check passes", async () => {
    const on = await planConnections(held, "/tmp/run", deps(true));
    expect(on.hostServices).toEqual([{ id: "northwind", ports: [8000, 5432] }]);
    expect(on.uses[0]?.use).toContain("northwind.host: ports 8000, 5432");
    const off = await planConnections(held, "/tmp/run", deps(false));
    expect(off.hostServices).toEqual([]);
    expect(off.uses).toEqual([]);
    expect(off.problems[0]).toContain("not connected");
  });
});
