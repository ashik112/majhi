import { type AutonomyMode, AutonomySettingsSchema, type AutonomyStatus } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../events/hub.ts";
import { estimateText } from "../runs/context.ts";
import type { Store } from "../store/index.ts";
import { backlogOrder, DIGEST_MAX_CHARS, type DigestInput, digest } from "./digest.ts";
import { AutonomyDriver, changeOf, DEBOUNCE_MS } from "./driver.ts";
import type { AutonomyService } from "./service.ts";

const CHAT = "LOCAL-1";

const STATUS: AutonomyStatus = {
  mode: "on",
  boss: { id: "boss", chat: CHAT, working: false },
  lanes: [
    {
      org: "acme",
      name: "Acme",
      chat: CHAT,
      working: false,
      spend: { used: { tokens: 0, cost: 0 }, percent: 0, reached: false },
      tasks: 0,
      backlog: 0,
    },
  ],
  now: [],
  queue: [],
  backlog: [],
  holds: [],
  spend: {
    day: "2026-10-01",
    tz: "UTC",
    resetsAt: "2026-10-02T00:00:00.000Z",
    total: { used: { tokens: 0, cost: 0 }, cap: { cost: 20 }, percent: 0, reached: false },
    orgs: [],
  },
  accounts: [],
  waiting: [],
  settings: AutonomySettingsSchema.parse({}),
  stopped: [],
  raised: {},
};

/**
 * A driver over fakes: the mode, whether the captain works and the day cap are the test's to set. Two
 * workspaces run: Acme (lane LOCAL-1) and Globex (lane LOCAL-9).
 */
function fakes() {
  const state = {
    mode: "on" as AutonomyMode,
    busy: false,
    capped: false,
    chat: CHAT as string | undefined,
    /** Autonomous tasks whose agents wait for a slot or start. */
    queued: new Set<string>(),
    running: new Set<string>(),
  };
  const ticks: string[][] = [];
  const tickOrgs: string[] = [];
  const told: string[] = [];
  const toldIn: string[] = [];
  const lanes: Record<string, string> = { acme: CHAT, globex: "LOCAL-9" };
  const autonomy = {
    repo: { state: () => ({ mode: state.mode, queue: [], holds: [] }), tasks: () => [] },
    mode: () => state.mode,
    runsOrgs: async () => ["acme"],
    laneChats: () => Object.values(lanes),
    laneOrg: (task: string) => Object.entries(lanes).find(([, chat]) => chat === task)?.[0],
    laneChat: async (org: string) =>
      state.mode !== "on" ? undefined : org === "acme" ? state.chat : lanes[org],
    pickable: async () => ({ backlog: [], leftOut: 0, rules: ["Task size: Any size."] }),
    isAutonomous: (task: string) => task === "ACM-1",
    dayCapped: () => state.capped,
    openTasks: () => [],
    answerable: () => [],
    backlog: () => [],
    status: async () => STATUS,
    ticked: (reasons: readonly string[], org: string) => {
      ticks.push([...reasons]);
      tickOrgs.push(org);
    },
    event: () => 1,
  };
  const driver = new AutonomyDriver({
    // A fake with only what the driver reads.
    autonomy: autonomy as unknown as AutonomyService,
    tasks: {
      tellAgent: async (input: { task: string; text: string }) => {
        told.push(input.text);
        toldIn.push(input.task);
      },
    },
    runs: {
      working: (task: string) => (task === state.chat && state.busy ? ["boss"] : []),
      busy: (task: string) => state.queued.has(task),
    },
    room: { onWrite: () => {} },
    store: {
      tasks: {
        get: (id: string) => (state.running.has(id) ? { id, status: "running", org: "acme" } : undefined),
        list: () => [],
      },
    } as unknown as Store,
    events: new EventHub(),
  });
  return { driver, state, ticks, tickOrgs, told, toldIn };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the driver", () => {
  it("batches what happens within the debounce into one tick", async () => {
    const f = fakes();
    f.driver.wake("ACM-1 is ready for review");
    await vi.advanceTimersByTimeAsync(10_000);
    f.driver.wake("ACM-2 paused (error)");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 10_000 - 1);
    expect(f.told).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.ticks).toEqual([["ACM-1 is ready for review", "ACM-2 paused (error)"]]);
    expect(f.told[0]).toContain("- ACM-2 paused (error)");
    // The next batch starts its own wait.
    f.driver.wake("Hourly check");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(2);
  });

  it("sends nothing while the captain is in a turn, and one tick when the turn ends", async () => {
    const f = fakes();
    f.state.busy = true;
    f.driver.wake("ACM-1 is ready for review");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    f.driver.wake("A card waits");
    await vi.advanceTimersByTimeAsync(5 * DEBOUNCE_MS);
    expect(f.told).toEqual([]);
    f.state.busy = false;
    f.driver.loopEnded(CHAT);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.ticks).toEqual([["ACM-1 is ready for review", "A card waits"]]);
    // The tick's own turn ending sends nothing more.
    f.driver.loopEnded(CHAT);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(1);
  });

  it("ticks only while the mode is on, and not under the day cap", async () => {
    const f = fakes();
    f.state.mode = "paused";
    f.driver.wake("ACM-1 is done");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.told).toEqual([]);

    f.state.mode = "on";
    f.driver.wake("ACM-1 is done");
    f.driver.onMode("stopping");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.told).toEqual([]);

    f.state.capped = true;
    f.driver.wake("Acme reached its cap");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.told).toEqual([]);
    f.state.capped = false;
    f.driver.wake("A new day lifted the day cap");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toEqual([["A new day lifted the day cap"]]);
  });
});

describe("the driver per lane", () => {
  it("batches each workspace apart and tells each lane only its own lines", async () => {
    const f = fakes();
    f.driver.wake("ACM-1 is ready for review", "acme");
    f.driver.wake("GLX-4 is done", "globex");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.toldIn.toSorted()).toEqual(["LOCAL-1", "LOCAL-9"]);
    const acme = f.told[f.toldIn.indexOf("LOCAL-1")] ?? "";
    const globex = f.told[f.toldIn.indexOf("LOCAL-9")] ?? "";
    expect(acme).toContain("ACM-1 is ready for review");
    expect(acme).not.toContain("GLX-4");
    expect(globex).toContain("GLX-4 is done");
    expect(globex).not.toContain("ACM-1");
    expect(f.tickOrgs.toSorted()).toEqual(["acme", "globex"]);
  });

  it("waits for the captain's turn in one lane without holding the other", async () => {
    const f = fakes();
    f.state.busy = true;
    f.driver.wake("ACM-1 is ready for review", "acme");
    f.driver.wake("GLX-4 is done", "globex");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.toldIn).toEqual(["LOCAL-9"]);
    f.state.busy = false;
    f.driver.loopEnded(CHAT);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.toldIn).toEqual(["LOCAL-9", "LOCAL-1"]);
  });
});

describe("the stuck check", () => {
  it("never wakes the captain for a running task whose agents wait for a slot, only for one nobody works on", async () => {
    const f = fakes();
    f.state.running.add("ACM-1");
    f.state.queued.add("ACM-1");
    f.driver.loopEnded("ACM-1");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toEqual([]);
    f.state.queued.delete("ACM-1");
    f.driver.loopEnded("ACM-1");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toEqual([["ACM-1 is running, but no agent is working on it"]]);
  });
});

describe("the driver and a chat that is gone", () => {
  it("wakes the captain in the chat majhi made again, and sends nothing when there is none", async () => {
    const f = fakes();
    // The service made a new chat because the old one was removed.
    f.state.chat = "LOCAL-2";
    f.driver.wake("ACM-1 is ready for review");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.toldIn).toEqual(["LOCAL-2"]);
    // No chat could be made (no captain): nothing is told, nothing ticks.
    f.state.chat = undefined;
    f.driver.wake("ACM-2 is done");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.toldIn).toEqual(["LOCAL-2"]);
    expect(f.ticks).toHaveLength(1);
  });
});

describe("the digest", () => {
  const long = (n: number) => `${"Rework the billing export so the totals match ".repeat(4)}${n}`;

  it("stays under about 1,500 tokens however long the lists are, and counts what it cut", () => {
    const input: DigestInput = {
      now: new Date("2026-10-01T12:00:00Z"),
      tz: "Europe/Berlin",
      reasons: Array.from({ length: 40 }, (_, i) => `reason ${i}: ${long(i)}`),
      spend: {
        ...STATUS.spend,
        orgs: Array.from({ length: 20 }, (_, i) => ({
          org: `org-${i}`,
          used: { tokens: 1_200_000, cost: 3.5 },
          cap: { cost: 5 },
          percent: 70,
          reached: false,
        })),
      },
      holds: Array.from({ length: 10 }, (_, i) => ({
        kind: "account" as const,
        id: `acct-${i}`,
        text: long(i),
      })),
      accounts: Array.from({ length: 30 }, (_, i) => ({
        id: `claude-${i}`,
        org: "acme",
        tool: "claude" as const,
        window: { usedPct: 40, resetsAt: "2026-10-01T14:00:00Z" },
        weekly: { usedPct: 70 },
      })),
      instructions: Array.from({ length: 50 }, (_, i) => ({
        id: `abcd${String(i).padStart(4, "0")}`,
        text: long(i),
        at: "2026-10-01T00:00:00Z",
      })),
      tasks: Array.from({ length: 100 }, (_, i) => ({
        task: `ACM-${i}`,
        title: long(i),
        org: "acme",
        status: "running" as const,
        agents: [{ id: "acme-builder", nowDoing: long(i) }],
      })),
      cards: Array.from({ length: 50 }, (_, i) => ({
        task: `ACM-${i}`,
        item: `ask:${i}`,
        kind: "ask",
        text: long(i),
      })),
      waiting: Array.from({ length: 30 }, (_, i) => ({
        task: `ACM-${i}`,
        item: `approval:${i}`,
        kind: "approval",
        text: long(i),
        why: "Only the owner removes things",
      })),
      backlog: Array.from({ length: 200 }, (_, i) => ({
        id: `GLX-${i}`,
        title: long(i),
        createdAt: "2026-09-01T00:00:00Z",
      })),
      leftOut: 12,
      rules: [
        "Task size: Up to medium.",
        "Orgs: only Acme.",
        "Tasks marked Not for autonomous mode are left alone.",
      ],
      queue: Array.from({ length: 20 }, (_, i) => ({ title: long(i), why: long(i) })),
    };
    const text = digest(input);
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(estimateText(text)).toBeLessThanOrEqual(1_500);
    expect(text).toContain("Autonomous mode, Thu 1 Oct, 14:00 (Europe/Berlin).");
    expect(text).toMatch(/- and \d+ more/);
    expect(text).toMatch(/- \d+ earlier/);
  });

  it("shows the pick rules, each backlog task's size, and how many the rules leave out", () => {
    const text = digest({
      now: new Date("2026-10-01T12:00:00Z"),
      tz: "UTC",
      reasons: ["Autonomous mode turned on"],
      spend: STATUS.spend,
      holds: [],
      accounts: [],
      instructions: [],
      tasks: [],
      cards: [],
      waiting: [],
      backlog: [
        { id: "ACM-1", org: "acme", title: "Fix the login form", size: "small", createdAt: "2026-09-01" },
        { id: "ACM-2", org: "acme", title: "Tidy the README", createdAt: "2026-09-02" },
      ],
      leftOut: 3,
      rules: ["Task size: Up to medium.", "Orgs: only Acme."],
      queue: [],
    });
    expect(text).toContain("- Task size: Up to medium.\n- Orgs: only Acme.");
    expect(text).toContain("- ACM-1 (acme) [small] Fix the login form");
    expect(text).toContain("- ACM-2 (acme) [size not known] Tidy the README");
    expect(text).toContain("- 3 more left out by the pick rules");
  });

  it("orders the backlog by priority, then the nearest due date, then age", () => {
    const order = backlogOrder([
      { id: "A", title: "a", createdAt: "2026-09-01" },
      { id: "B", title: "b", priority: "low", createdAt: "2026-08-01" },
      { id: "C", title: "c", priority: "high", due: "2026-10-09", createdAt: "2026-09-05" },
      { id: "D", title: "d", priority: "high", due: "2026-10-03", createdAt: "2026-09-06" },
      { id: "E", title: "e", due: "2026-10-02", createdAt: "2026-09-07" },
      { id: "F", title: "f", createdAt: "2026-08-15" },
    ]).map((t) => t.id);
    expect(order).toEqual(["D", "C", "E", "F", "A", "B"]);
  });
});

describe("what the log says about a paused task", () => {
  const task = { id: "ACM-9", title: "Move the notes export" } as const;
  it("never blames the owner for a pause Autonomous or the captain made", () => {
    expect(
      changeOf({ ...task, status: "paused", pausedReason: "owner", pausedBy: "autonomy-off" })?.text,
    ).toBe("Paused 'Move the notes export' because Autonomous was turned off");
    expect(changeOf({ ...task, status: "paused", pausedReason: "owner", pausedBy: "captain" })?.text).toBe(
      "Paused 'Move the notes export' by Captain",
    );
    expect(changeOf({ ...task, status: "paused", pausedReason: "owner" })?.text).toBe(
      "Paused 'Move the notes export' by you",
    );
  });
});
