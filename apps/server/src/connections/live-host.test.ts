import { describe, expect, it } from "vitest";
import { type LiveHostDeps, LiveHostServices } from "./live-host.ts";

/** Which tasks and agents a service on this computer reaches the moment it connects, and what each is told. */
function world(overrides: Partial<LiveHostDeps> = {}) {
  const log = {
    forwarded: [] as string[],
    said: [] as string[],
    told: [] as string[],
    stopped: [] as string[],
  };
  const running = new Set<string>();
  const deps: LiveHostDeps = {
    connection: async (id) =>
      id === "northwind"
        ? { org: "acme", type: "host", ports: "8000, 5432", agentsOff: ["acme-reviewer"] }
        : id === "notes"
          ? { org: "acme", type: "env", ports: undefined, agentsOff: [] }
          : undefined,
    sessions: () => [
      { task: "ACM-1", agent: "acme-builder" },
      { task: "ACM-1", agent: "acme-reviewer" },
      { task: "ACM-2", agent: "acme-builder" },
      { task: "GLB-1", agent: "globex-builder" },
      { task: "ACM-3", agent: "root-captain" },
      { task: "ACM-4", agent: "globex-builder" },
    ],
    taskOrg: (t) => (t.startsWith("ACM") ? "acme" : "globex"),
    agentScope: async (a) => (a === "root-captain" ? "root" : a.startsWith("acme") ? "acme" : "globex"),
    forward: async (task, services) => {
      const started: string[] = [];
      for (const s of services) {
        const key = `${task}:${s.id}:${s.ports.join(",")}`;
        if (running.has(key)) continue;
        running.add(key);
        log.forwarded.push(key);
        started.push(s.id);
      }
      return started;
    },
    stop: async (id) => {
      log.stopped.push(id);
      return ["ACM-1", "ACM-2"];
    },
    say: (task, text) => log.said.push(`${task}: ${text}`),
    tell: (task, agent, text) => log.told.push(`${task}/${agent}: ${text}`),
    ...overrides,
  };
  return { live: new LiveHostServices(deps), log };
}

describe("a service on this computer that connects while agents work", () => {
  it("starts a forwarder in every task of its workspace with a live session, and tells the agents allowed to use it", async () => {
    const { live, log } = world();
    await live.connected("northwind");
    // Not the other workspace, and not a task whose only agent is turned off for it (ACM-1 still has the builder).
    expect(log.forwarded).toEqual([
      "ACM-1:northwind:8000,5432",
      "ACM-2:northwind:8000,5432",
      "ACM-3:northwind:8000,5432",
    ]);
    expect(log.said.map((l) => l.split(":")[0])).toEqual(["ACM-1", "ACM-2", "ACM-3"]);
    expect(log.told.map((l) => l.split(":")[0])).toEqual([
      "ACM-1/acme-builder",
      "ACM-2/acme-builder",
      "ACM-3/root-captain",
    ]);
    expect(log.told[0]).toContain("northwind.host is now reachable");
  });

  it("changes nothing when the check passes again", async () => {
    const { live, log } = world();
    await live.connected("northwind");
    const said = log.said.length;
    await live.connected("northwind");
    expect(log.said).toHaveLength(said);
    expect(log.told).toHaveLength(3);
  });

  it("ignores connections that are not services on this computer, or are gone", async () => {
    const { live, log } = world();
    await live.connected("notes");
    await live.connected("missing");
    expect(log.forwarded).toEqual([]);
  });

  it("a failed start becomes one line in that task and does not stop the others", async () => {
    let calls = 0;
    const { live, log } = world({
      forward: async (task, services) => {
        calls++;
        if (task === "ACM-1") throw new Error("Docker is down");
        return services.map((s) => s.id);
      },
    });
    await live.connected("northwind");
    expect(calls).toBe(3);
    expect(log.said[0]).toBe("ACM-1: northwind.host could not start in this task: Docker is down");
    expect(log.told.every((l) => !l.startsWith("ACM-1"))).toBe(true);
  });

  it("stops the forwarders and says so in each task that had one when it ends", async () => {
    const { live, log } = world();
    await live.ended("northwind", "It was removed.");
    expect(log.stopped).toEqual(["northwind"]);
    expect(log.said).toEqual([
      "ACM-1: northwind.host is no longer reachable from this task. It was removed.",
      "ACM-2: northwind.host is no longer reachable from this task. It was removed.",
    ]);
  });

  it("a port change stops first and starts again only while it is connected, in that order", async () => {
    const order: string[] = [];
    const { live } = world({
      stop: async () => {
        order.push("stop");
        return [];
      },
      forward: async (_task, services) => {
        order.push("forward");
        return services.map((s) => s.id);
      },
    });
    await live.changed("northwind", true);
    expect(order.slice(0, 2)).toEqual(["stop", "forward"]);
    order.length = 0;
    await live.changed("northwind", false);
    expect(order).toEqual(["stop"]);
  });
});
