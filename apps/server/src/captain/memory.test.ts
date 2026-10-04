import type { Fact, FactStatus, MemoryScope } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/service.ts";
import type { EventHub } from "../events/hub.ts";
import { Store } from "../store/index.ts";
import type { Lanes } from "./lanes.ts";
import { laneOfScope, laneScopes } from "./memory-scopes.ts";
import type { CaptainPorts } from "./ports.ts";
import { DAILY_CAPS, MEMORY_WAITING } from "./rules.ts";
import { type AutonomyLink, CaptainService } from "./service.ts";
import { captainWorld, type WorldDeps } from "./world.ts";

/**
 * The memory chore's owners and triggers (SPEC 5.18, Memory): global memories are Private's to
 * review and never reach a client workspace, a backlog runs the chore once, the captain's own writes
 * start nothing, and the daily cap holds. Over a database in memory and a fake memory store.
 */

const DAY = "2026-10-04";
const PROJECTS = { "acme-api": { org: "acme" }, "globex-web": { org: "globex" }, notes: { org: "private" } };
/** The captain's lane in Private. */
const LANE = "PRV-90";

interface Stored {
  id: number;
  text: string;
  scope: MemoryScope;
  status: FactStatus;
  task?: string;
}

function setup() {
  const facts: Stored[] = [];
  let seq = 0;
  const add = (scope: MemoryScope, task = "ACM-1") => {
    seq += 1;
    const fact: Stored = { id: seq, text: `Memory ${seq} in ${scope}`, scope, status: "pending", task };
    facts.push(fact);
    return fact;
  };
  const config = {
    sections: async () => ({
      orgs: { acme: { name: "Acme" }, globex: { name: "Globex" } },
      projects: PROJECTS,
      boss: "captain",
    }),
    settings: async () => ({
      autonomy: {
        tz: "UTC",
        summary_at: "08:00",
        pick: {},
        orgs: {
          acme: { level: "tidy", push: false, merge: false },
          globex: { level: "tidy", push: false, merge: false },
        },
      },
    }),
  } as unknown as ConfigService;
  // The real port reads pending memories; only `list` of the memory store is played.
  const world = captainWorld({
    config,
    memory: {
      list: (f: { status?: FactStatus; scopes?: readonly MemoryScope[] }) =>
        facts.filter((x) => x.status === f.status && (f.scopes ?? []).includes(x.scope)),
    },
  } as unknown as WorldDeps);
  const curated: { org: string; id: number }[] = [];
  const hold = {
    release: undefined as (() => void) | undefined,
    held: undefined as Promise<void> | undefined,
  };
  const ports = {
    pendingFacts: (org: string) => world.pendingFacts(org),
    curate: async (org: string, fact: { id: number }) => {
      if (hold.held !== undefined) await hold.held;
      curated.push({ org, id: fact.id });
      const f = facts.find((x) => x.id === fact.id);
      if (f !== undefined) f.status = "active";
      return { outcome: "kept" as const };
    },
  } as unknown as CaptainPorts;
  const store = new Store(":memory:");
  const captain = new CaptainService({
    store,
    config,
    events: { emit: () => {} } as unknown as EventHub,
    autonomy: { mode: () => "on" } as unknown as AutonomyLink,
    lanes: {
      orgOf: (task: string) => (task === LANE ? "private" : undefined),
      chat: () => undefined,
      all: () => [],
    } as unknown as Lanes,
    ports,
    tell: () => {},
    cancelTurn: async () => {},
    identity: async () => ({ name: "majhi", email: "majhi@example.com" }),
    ownerCommand: async () => {},
    triggerMs: 0,
    now: () => new Date(`${DAY}T12:00:00.000Z`),
  });
  const waiting = async (fact: Stored) => captain.memoryWaiting(fact as Pick<Fact, "scope" | "task">);
  const runs = (org: string) => captain.repo.allRuns().filter((r) => r.org === org && r.chore === "memory");
  /** Holds every curation until `free` is called. */
  const block = () => {
    hold.held = new Promise((r) => {
      hold.release = r;
    });
  };
  const free = () => {
    hold.release?.();
    hold.held = undefined;
  };
  return { facts, add, captain, curated, waiting, runs, block, free };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(check()).toBe(true);
}

describe("which workspace reviews which memories", () => {
  it("gives global memories to Private, and a client workspace only its own", () => {
    expect(laneScopes("private", PROJECTS)).toEqual(["global", "org:private", "project:notes"]);
    expect(laneScopes("acme", PROJECTS)).toEqual(["org:acme", "project:acme-api"]);
    expect(laneOfScope("global", PROJECTS)).toBe("private");
    expect(laneOfScope("project:globex-web", PROJECTS)).toBe("globex");
    expect(laneOfScope("org:acme", PROJECTS)).toBe("acme");
    expect(laneOfScope("project:gone", PROJECTS)).toBeUndefined();
  });

  it("curates global memories in Private's run, all of them in one run, and never in a client's", async () => {
    const t = setup();
    for (let i = 0; i < 12; i++) t.add("global");
    for (let i = 0; i < 15; i++) t.add("project:notes", "PRV-1");
    const acme = t.add("org:acme");
    const globex = t.add("project:globex-web", "GLX-1");

    expect(await t.captain.runner.start("acme", "memory", "test")).toBe("done");
    expect(t.curated).toEqual([{ org: "acme", id: acme.id }]);

    // 27 memories, more than one chunk of 20, all in Private's one run.
    expect(await t.captain.runner.start("private", "memory", "test")).toBe("done");
    const mine = t.curated.filter((c) => c.org === "private").map((c) => c.id);
    expect(mine).toHaveLength(27);
    expect(t.facts.filter((f) => f.scope === "global").every((f) => mine.includes(f.id))).toBe(true);
    expect(mine).not.toContain(globex.id);
    expect(mine).not.toContain(acme.id);
  });
});

describe("the memory chore when memories pile up", () => {
  it("runs once the backlog reaches the threshold, joins the run for more, and not for the captain's own", async () => {
    const t = setup();
    for (let i = 0; i < MEMORY_WAITING - 1; i++) await t.waiting(t.add("org:acme"));
    await t.captain.settled();
    expect(t.runs("acme")).toEqual([]);

    t.block();
    await t.waiting(t.add("project:acme-api"));
    await until(() => t.captain.runner.running("acme", "memory"));
    // More arrive while it runs: they join it, no second run starts.
    for (let i = 0; i < MEMORY_WAITING; i++) await t.waiting(t.add("org:acme"));
    t.free();
    await t.captain.settled();
    expect(t.runs("acme")).toHaveLength(1);
    expect(t.runs("acme")[0]?.trigger).toBe(`${MEMORY_WAITING} memories wait for review`);
    expect(t.facts.filter((f) => f.status === "pending")).toEqual([]);

    // The captain's own lane writes a backlog: nothing starts.
    const dropped = t.captain.runner.selfDropped;
    for (let i = 0; i < MEMORY_WAITING + 2; i++) await t.waiting(t.add("global", LANE));
    await t.captain.settled();
    expect(t.runs("private")).toEqual([]);
    expect(t.captain.runner.selfDropped).toBe(dropped + MEMORY_WAITING + 2);
    // Memories it already looked at do not count, so nothing starts again either.
    await t.waiting(t.add("org:acme"));
    await t.captain.settled();
    expect(t.runs("acme")).toHaveLength(1);
  });

  it("holds the daily cap of memory runs", async () => {
    const t = setup();
    for (let round = 0; round < 7; round++) {
      for (let i = 0; i < MEMORY_WAITING; i++) await t.waiting(t.add("org:acme"));
      await t.captain.settled();
    }
    expect(t.runs("acme")).toHaveLength(DAILY_CAPS.memory.runs ?? 0);
    expect(DAILY_CAPS.memory.runs).toBe(4);
    // The rest waits for tomorrow.
    expect(t.facts.filter((f) => f.status === "pending")).toHaveLength(3 * MEMORY_WAITING);
  });
});

describe("Review now", () => {
  it("runs the memory chore past today's cap once, says so, and refuses a second run while one goes", async () => {
    const t = setup();
    for (let round = 0; round < 7; round++) {
      for (let i = 0; i < MEMORY_WAITING; i++) await t.waiting(t.add("org:acme"));
      await t.captain.settled();
    }
    expect(t.runs("acme")).toHaveLength(4);
    const waiting = t.facts.filter((f) => f.status === "pending").length;
    expect(waiting).toBe(3 * MEMORY_WAITING);

    t.block();
    const first = await t.captain.runChore("acme", "memory");
    expect(first).toMatchObject({ started: true, overCap: true });
    expect(first.text).toMatch(/goes past it because you asked/);
    await until(() => t.captain.runner.running("acme", "memory"));
    const second = await t.captain.runChore("acme", "memory");
    expect(second).toEqual({ started: false, overCap: false, text: "Memory is already running here." });
    t.free();
    await t.captain.settled();
    expect(t.runs("acme")).toHaveLength(5);
    expect(t.facts.filter((f) => f.status === "pending")).toEqual([]);
  });

  it("starts under the cap without saying anything about it, and says why when a workspace is unknown", async () => {
    const t = setup();
    t.add("org:acme");
    expect(await t.captain.runChore("acme", "memory")).toEqual({
      started: true,
      overCap: false,
      text: "Started memory.",
    });
    await t.captain.settled();
    expect((await t.captain.runChore("nowhere", "memory")).started).toBe(false);
  });
});
