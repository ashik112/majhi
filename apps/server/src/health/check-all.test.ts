import type { EventTopic } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { ServerEnv } from "../env.ts";
import type { Services } from "../services.ts";
import type { Check } from "./checks.ts";
import { type CheckUnit, runUnits } from "./run-all.ts";
import { HealthService } from "./service.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("runUnits", () => {
  it("never runs more than the limit at once, and runs every unit", async () => {
    let inFlight = 0;
    let peak = 0;
    const ran: string[] = [];
    const units: CheckUnit[] = Array.from({ length: 12 }, (_, i) => ({
      id: `u${i}`,
      weight: 1,
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        ran.push(`u${i}`);
        inFlight -= 1;
      },
    }));
    const done: string[] = [];
    await runUnits(units, 3, ({ unit }) => {
      done.push(unit.id);
    });
    expect(peak).toBe(3);
    expect(ran).toHaveLength(12);
    expect(done).toHaveLength(12);
  });

  it("goes on after a unit throws and reports which one", async () => {
    const units: CheckUnit[] = ["a", "b", "c"].map((id) => ({
      id,
      weight: 1,
      run: async () => {
        if (id === "b") throw new Error("boom");
      },
    }));
    const out = await runUnits(units, 2, () => {
      throw new Error("a broken listener");
    });
    expect(out.map((o) => [o.unit.id, o.error !== undefined]).sort()).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ]);
  });
});

/** A health service whose doctor checks and services are stubs, so the run's rules are what is tested. */
function build(options: { accounts: string[]; connections: { id: string; problems?: string[] }[] }) {
  const calls: string[] = [];
  const failing = new Set<string>();
  let inFlight = 0;
  let peak = 0;
  const topics: EventTopic[][] = [];
  const stored = new Map<string, string>();
  const track = async (key: string) => {
    calls.push(key);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight -= 1;
    if (failing.has(key)) throw new Error(`${key} blew up\nmore`);
    stored.set(key, new Date().toISOString());
  };
  const services = {
    accounts: {
      list: async () => options.accounts.map((id) => ({ id })),
      health: async (id: string) => track(`account:${id}`),
    },
    connections: {
      list: async () => options.connections.map((c) => ({ id: c.id, problems: c.problems ?? [] })),
    },
    connectionTests: { test: async (id: string) => track(`connection:${id}`) },
  } as unknown as Services;
  class Stubbed extends HealthService {
    override async checks(): Promise<Check[]> {
      const doctor: Check[] = [
        { id: "config", group: "majhi", name: "Config", status: "pass", detail: "ok" },
        { id: "disk", group: "disk", name: "Disk", status: "warn", detail: "low" },
      ];
      const accounts: Check[] = options.accounts.map((id) => ({
        id: `account:${id}`,
        group: "accounts",
        name: id,
        status: "pass",
        detail: "Signed in",
        ...(stored.has(`account:${id}`) ? { checkedAt: stored.get(`account:${id}`) as string } : {}),
      }));
      const connections: Check[] = options.connections.map((c) => ({
        id: `connection:${c.id}`,
        group: "connections",
        name: c.id,
        status: "pass",
        detail: "fine",
        ...(stored.has(`connection:${c.id}`)
          ? { checkedAt: stored.get(`connection:${c.id}`) as string }
          : {}),
      }));
      return [...doctor, ...accounts, ...connections];
    }
  }
  const health = new Stubbed({
    env: {} as ServerEnv,
    services,
    config: {} as never,
    hostLink: {} as never,
    remount: async () => "unavailable" as never,
    events: { emit: (t) => topics.push([...t]) },
  });
  const finished = async () => {
    for (let i = 0; i < 500 && (await health.run()).run.running; i += 1) await tick();
  };
  return { health, calls, failing, peak: () => peak, topics, finished };
}

describe("health.checkAll", () => {
  it("shows a check that threw as failed, finishes the rest, and recovers on the next run", async () => {
    const t = build({ accounts: ["a1"], connections: [{ id: "c1" }, { id: "c2" }] });
    t.failing.add("connection:c1");
    await t.health.checkAll();
    await t.finished();
    expect(t.calls).toHaveLength(3);
    const row = (await t.health.run()).checks.find((c) => c.id === "connection:c1");
    expect(row).toMatchObject({ ok: false, level: "fail" });
    expect((await t.health.run()).lastFullRunAt).toBeDefined();
    expect((await t.health.run()).checks.find((c) => c.id === "connection:c2")?.level).toBe("pass");

    t.failing.clear();
    await t.health.checkAll();
    await t.finished();
    expect((await t.health.run()).checks.find((c) => c.id === "connection:c1")?.level).toBe("pass");
  });

  it("does not start a second run while one is going", async () => {
    const t = build({ accounts: ["a1", "a2"], connections: [{ id: "c1" }] });
    const [first, second] = await Promise.all([t.health.checkAll(), t.health.checkAll()]);
    expect([first.started, second.started].sort()).toEqual([false, true]);
    await t.finished();
    expect(t.calls).toHaveLength(3);
  });
});
