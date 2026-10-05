import {
  ALL_ASK,
  type AutonomyMode,
  type AutonomyNow,
  AutonomySettingsSchema,
  type AutonomyStatus,
} from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../events/hub.ts";
import { estimateText } from "../runs/context.ts";
import type { Store } from "../store/index.ts";
import {
  type BacklogTask,
  backlogOrder,
  DIGEST_MAX_CHARS,
  type DigestInput,
  digest,
  type StartGate,
} from "./digest.ts";
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
  running: [],
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
  // Acme decides when work starts; Globex (default) leaves it to the owner.
  settings: AutonomySettingsSchema.parse({ orgs: { acme: { authority: { ...ALL_ASK, start: "decide" } } } }),
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
    /** What the captain would see in the digest: the tasks of Acme. */
    now: [] as AutonomyNow[],
    /** Running tasks whose silence something explains (a cap, a card for the owner, a slot). */
    explained: new Set<string>(),
    /** Every task of the store, any workspace. */
    all: [] as Record<string, unknown>[],
    incidents: {} as Record<string, string[]>,
    /** The start gates holding tasks of Acme's backlog, by task id. */
    gates: {} as Record<string, StartGate>,
    backlog: [] as BacklogTask[],
  };
  const ticks: string[][] = [];
  const tickOrgs: string[] = [];
  const skipped: string[][] = [];
  const told: string[] = [];
  const toldIn: string[] = [];
  const lanes: Record<string, string> = { acme: CHAT, globex: "LOCAL-9" };
  const autonomy = {
    repo: { state: () => ({ mode: state.mode, queue: [], holds: [] }), tasks: () => [] },
    mode: () => state.mode,
    machineLine: () => undefined,
    machineBusy: () => undefined,
    runsOrgs: async () => ["acme"],
    laneChats: () => Object.values(lanes),
    laneOrg: (task: string) => Object.entries(lanes).find(([, chat]) => chat === task)?.[0],
    laneChat: async (org: string) =>
      state.mode !== "on" ? undefined : org === "acme" ? state.chat : lanes[org],
    startGates: async () => state.gates,
    pickable: async () => ({ backlog: state.backlog, leftOut: 0, rules: ["Task size: Any size."] }),
    isAutonomous: (task: string) => task === "ACM-1",
    dayCapped: () => state.capped,
    openTasks: () => [],
    answerable: () => [],
    backlog: () => [],
    status: async () => ({ ...STATUS, now: state.now }),
    ticked: (reasons: readonly string[], org: string) => {
      ticks.push([...reasons]);
      tickOrgs.push(org);
    },
    event: () => 1,
    skipped: (reasons: readonly string[]) => {
      skipped.push([...reasons]);
    },
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
        list: () => state.all,
      },
    } as unknown as Store,
    events: new EventHub(),
    explained: (task: string) => (state.explained.has(task) ? "held" : undefined),
    incidentLines: (org: string) => state.incidents[org] ?? [],
  });
  return { driver, state, ticks, tickOrgs, told, toldIn, skipped };
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

const FULL: StartGate = {
  kind: "workspace",
  text: "Acme works on 1 task at once and ACM-1 is running.",
  key: "1:ACM-1",
};

describe("start gates", () => {
  const waiting = (id: string): BacklogTask => ({ id, title: `Work on ${id}`, createdAt: "2026-10-01" });

  it("names the gate that holds a backlog task, before the captain decides", async () => {
    const f = fakes();
    f.state.backlog = [waiting("ACM-2")];
    f.state.gates = { "ACM-2": FULL };
    f.driver.wake("New in the backlog: ACM-2", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.told[0]).toContain(
      "ACM-2 [size not known] waits: Acme works on 1 task at once and ACM-1 is running.",
    );
  });

  it("does not wake again for a refusal by the same gate, and wakes once when the gate clears", async () => {
    const f = fakes();
    f.state.backlog = [waiting("ACM-2")];
    f.state.gates = { "ACM-2": FULL };
    f.driver.wake("New in the backlog: ACM-2", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(1);
    // The start is refused again and again: stalls of the held task are soft and change no fact.
    for (let i = 0; i < 5; i++) {
      f.driver.wake("ACM-2 is running, but no agent is working on it", "acme", "soft");
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    }
    expect(f.ticks).toHaveLength(1);
    // The running task finished: the gate clears, one wake.
    f.state.gates = {};
    f.driver.wake("ACM-2 is running, but no agent is working on it", "acme", "soft");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(2);
    expect(f.told[1]).not.toContain("waits:");
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
    // An alarm is soft: with nothing the captain has seen to compare against, it is not news.
    expect(f.ticks).toEqual([]);
  });
});

const task = (id: string, status: AutonomyNow["status"] = "running"): AutonomyNow => ({
  task: id,
  title: `Work on ${id}`,
  org: "acme",
  status,
  agents: [{ id: "acme-builder", nowDoing: "reading" }],
});

describe("wakes carry news only", () => {
  it("makes one wake of a storm: 100 events in a second, all reasons, repeats counted", async () => {
    const f = fakes();
    for (let i = 0; i < 100; i++) {
      f.driver.wake(i % 2 === 0 ? "A card waits in ACM-1" : `ACM-${i} is done`, "acme");
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.told).toHaveLength(1);
    expect(f.told[0]).toContain("A card waits in ACM-1 (x50)");
    expect(f.told[0]).toContain("- ACM-99 is done");
    expect(f.ticks).toHaveLength(1);
  });

  it("sends nothing when the facts and the news are the ones the captain saw", async () => {
    const f = fakes();
    f.state.now = [task("ACM-1")];
    f.driver.wake("ACM-1 is ready for review", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(1);
    // The same news again with nothing else changed: not sent.
    f.driver.wake("ACM-1 is ready for review", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(1);
    expect(f.skipped).toEqual([["ACM-1 is ready for review"]]);
    // What an agent is doing right now is not a fact: it changes all the time.
    f.state.now = [{ ...task("ACM-1"), agents: [{ id: "acme-builder", nowDoing: "editing" }] }];
    f.driver.wake("ACM-1 is ready for review", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(1);
  });

  it("sends a real change once, and a soft alarm only when the facts changed", async () => {
    const f = fakes();
    f.state.now = [task("ACM-1")];
    f.driver.wake("ACM-1 is ready for review", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // An alarm over the same facts: nothing.
    f.state.running.add("ACM-1");
    f.driver.loopEnded("ACM-1");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(1);
    // The task finished: news and a changed fact, one wake.
    f.state.now = [task("ACM-1", "done")];
    f.driver.wake("ACM-1 is done: Work on ACM-1", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(2);
    // A soft alarm that comes with a changed fact goes too.
    f.state.now = [task("ACM-1", "done"), task("ACM-2")];
    f.driver.loopEnded("ACM-1");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(3);
  });

  it("never wakes for a stall something explains: a cap, a card for the owner, a slot", async () => {
    const f = fakes();
    f.state.running.add("ACM-1");
    f.state.explained.add("ACM-1");
    for (let i = 0; i < 20; i++) f.driver.loopEnded("ACM-1");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toEqual([]);
    expect(f.told).toEqual([]);
  });

  it("does not count the captain's own changes as news: the facts after its turn are the baseline", async () => {
    const f = fakes();
    f.state.now = [task("ACM-1")];
    f.driver.wake("ACM-1 is ready for review", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // In its turn the captain started ACM-2. Its turn ends; a stall alarm then finds the same facts.
    f.state.now = [task("ACM-1"), task("ACM-2")];
    f.driver.loopEnded(CHAT);
    await vi.advanceTimersByTimeAsync(0);
    f.state.running.add("ACM-2");
    f.driver.loopEnded("ACM-2");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(1);
  });

  it("makes no wake of its own on the hour: unchanged facts and a quiet hour tell the captain nothing", async () => {
    const f = fakes();
    f.state.now = [task("ACM-1")];
    f.driver.wake("ACM-1 is ready for review", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    f.driver.sweep();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(1);
    // A task that finished meanwhile is news: it wakes the captain on the next look.
    f.state.now = [task("ACM-1", "done")];
    f.driver.wake("ACM-1 is done: Work on ACM-1", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks).toHaveLength(2);
  });

  it("tells a lane where Start is You about a finding, and that it only proposes there", async () => {
    const f = fakes();
    // Globex: the default authority of a client workspace has Start on "You".
    f.driver.findingNews("globex", "New finding #4 (high): Globex api has an outdated runtime");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.toldIn).toEqual(["LOCAL-9"]);
    expect(f.told[0]).toContain("New finding #4 (high)");
    expect(f.told[0]).toContain("The owner decides when work starts in this workspace");
    expect(f.told[0]).toContain("majhi_findings_toTask");
    // Acme decides starts: no such line.
    f.driver.findingNews("acme", "New finding #5 (low): Acme readme is thin");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.told[1]).not.toContain("The owner decides when work starts");
  });
});

describe("the lane runs the whole workspace", () => {
  const task = (id: string, org: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    org,
    status,
    title: `Task ${id}`,
    kind: "code",
    ...extra,
  });

  it("shows its own workspace's incidents, review and paused tasks, never another's", async () => {
    const f = fakes();
    f.state.all = [
      task("ACM-5", "acme", "review"),
      task("GLX-5", "globex", "review"),
      task("ACM-6", "acme", "paused", { pausedReason: "limit" }),
      task("ACM-7", "acme", "paused"),
      task("GLX-6", "globex", "paused", { pausedReason: "error" }),
    ];
    f.state.incidents = {
      acme: ["incident #3 [high, not acknowledged] Acme site is down"],
      globex: ["incident #4 [high, not acknowledged] Globex api is down"],
    };
    f.driver.wake("A card waits", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const text = f.told[0] ?? "";
    expect(text).toContain("incident #3 [high, not acknowledged] Acme site is down");
    expect(text).toContain("ACM-5 Task ACM-5");
    expect(text).toContain("ACM-6 Task ACM-6 (because an account limit was reached)");
    expect(text).toContain("ACM-7 Task ACM-7 (by you: the owner's, leave it paused)");
    expect(text).not.toContain("Globex");
    expect(text).not.toContain("GLX-");
  });

  it("wakes the lane for a task of the workspace that enters review or pauses, and never for an owner pause", async () => {
    const f = fakes();
    f.state.all = [task("ACM-8", "acme", "running"), task("ACM-9", "acme", "running")];
    f.driver.start();
    f.state.all = [
      task("ACM-8", "acme", "review"),
      task("ACM-9", "acme", "paused", { pausedReason: "error" }),
    ];
    f.driver.checkTasks();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks[0]).toEqual(["ACM-8 is ready for review: Task ACM-8", "ACM-9 paused (error): Task ACM-9"]);
    expect(changeOf({ id: "ACM-1", title: "T", status: "paused", pausedReason: "owner" })?.wake).toBe(false);
    expect(changeOf({ id: "ACM-1", title: "T", status: "paused", pausedReason: "limit" })?.wake).toBe(true);
  });

  it("wakes the lane when its workspace gets a new incident", async () => {
    const f = fakes();
    f.driver.wake("A card waits", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    f.state.incidents = { acme: ["incident #9 [high, not acknowledged] Acme site is down"] };
    f.driver.wake("Incident #9 (high) in Acme: Acme site is down", "acme");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ticks.at(-1)).toEqual(["Incident #9 (high) in Acme: Acme site is down"]);
    expect(f.told.at(-1)).toContain("incident #9");
  });
});

describe("a busy hour", () => {
  /**
   * The same hour of events, with and without the news rule. "Before" is what the driver did: every
   * non-empty batch of wakes (debounced 20 s) became a captain turn. "After" is the driver as built.
   */
  it("makes far fewer wakes than before, and keeps every real change", async () => {
    const f = fakes();
    const hour = 60 * 60_000;
    const events: { at: number; run: () => void; real: boolean }[] = [];
    let id = 0;
    // 40 stall alarms spread over the hour, each over unchanged facts.
    for (let i = 0; i < 40; i++) {
      events.push({
        at: Math.floor(((i + 0.5) / 40) * hour),
        real: false,
        run: () => {
          f.state.running.add("ACM-1");
          f.driver.loopEnded("ACM-1");
        },
      });
    }
    // 12 real changes: tasks done, review, a new finding, a card.
    for (let i = 0; i < 12; i++) {
      events.push({
        at: Math.floor(((i + 0.25) / 12) * hour),
        real: true,
        run: () => {
          id += 1;
          f.state.now = [...f.state.now, task(`ACM-${100 + id}`, i % 2 === 0 ? "done" : "review")];
          f.driver.wake(`ACM-${100 + id} changed`, "acme");
        },
      });
    }
    // 59 minute sweeps over a workspace with nothing waiting.
    for (let m = 1; m < 60; m++) events.push({ at: m * 60_000, real: false, run: () => f.driver.sweep() });
    events.sort((a, b) => a.at - b.at);

    // Before: every stall alarm and change was a wake, batched by the debounce; the old sweep woke once an hour.
    let before = 1;
    let batchEnd = -1;
    for (const e of events.filter((x) => x.real || x.at % 60_000 !== 0)) {
      if (e.at >= batchEnd) {
        before += 1;
        batchEnd = e.at + DEBOUNCE_MS;
      }
    }

    let clock = 0;
    for (const e of events) {
      await vi.advanceTimersByTimeAsync(e.at - clock);
      clock = e.at;
      e.run();
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const after = f.ticks.length;
    console.info(`busy hour: ${before} wakes before, ${after} after (${f.skipped.length} batches held back)`);
    expect(after).toBeLessThanOrEqual(12);
    expect(after).toBeLessThan(before / 3);
    // Every real change reached the captain.
    const told = f.told.join("\n");
    for (let n = 1; n <= id; n++) expect(told).toContain(`ACM-${100 + n} changed`);
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
    ).toBe("Paused 'Move the notes export' because Auto-pilot was turned off");
    expect(changeOf({ ...task, status: "paused", pausedReason: "owner", pausedBy: "captain" })?.text).toBe(
      "Paused 'Move the notes export' by Captain",
    );
    expect(changeOf({ ...task, status: "paused", pausedReason: "owner" })?.text).toBe(
      "Paused 'Move the notes export' by you",
    );
  });
});
