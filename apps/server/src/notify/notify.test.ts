import { type AttentionEvent, NotificationsSettingsSchema, type ServerEvent } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../events/hub.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { inQuietHours } from "./attention.ts";
import { CAPTAIN_GRACE_MS, COLLECT_MS, type DesktopNotice, Notifier, SETTLE_MS } from "./service.ts";

let w: World;
let notifier: Notifier;
let sent: AttentionEvent[];
let desktop: DesktopNotice[];
let hub: EventHub;
let captainHandles = false;

const SETTLED = SETTLE_MS + COLLECT_MS + 10;

async function setup(settings = NotificationsSettingsSchema.parse({})): Promise<void> {
  captainHandles = false;
  w = await taskWorld();
  expect(
    (await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: false }))
      .status,
  ).toBe(200);
  const { store, room } = w.h.majhi.services;
  hub = new EventHub();
  sent = [];
  desktop = [];
  hub.subscribe((e: ServerEvent) => {
    if (e.type === "attention") sent.push(e);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  notifier = new Notifier({
    subject: (id) => {
      const t = store.tasks.get(id);
      return t === undefined ? undefined : { id: t.id, title: t.title, chat: false };
    },
    item: (task, id) => store.room.get(task, id),
    settings: async () => settings,
    captainHandles: async () => captainHandles,
    events: hub,
    desktop: async (n) => {
      desktop.push(n);
    },
  });
  room.onWrite((task, item) => notifier.observe(task, item));
}

afterEach(async () => {
  notifier?.close();
  vi.useRealTimers();
  await w?.cleanup();
});

const approval = (id: string, state: "pending" | "applied" = "pending") =>
  w.h.majhi.services.room.post("ACM-1", id, {
    type: "approval",
    agent: "acme-builder",
    command: "orgs.create",
    risk: "change",
    summary: "run migrations",
    input: "{}",
    state,
  });

describe("an item that needs the owner", () => {
  beforeEach(() => undefined);

  it("sends exactly one notification for an approval, even when the card is written again", async () => {
    await setup();
    approval("a1");
    approval("a1");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "approval",
      task: "ACM-1",
      path: "/t/ACM-1",
      text: "ACM-1 needs approval: run migrations",
      count: 1,
    });
    expect(desktop).toEqual([
      { title: "majhi", message: "ACM-1 needs approval: run migrations", path: "/t/ACM-1", sound: false },
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when the owner answers within five seconds", async () => {
    await setup();
    approval("a1");
    await vi.advanceTimersByTimeAsync(2_000);
    approval("a1", "applied");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    expect(desktop).toEqual([]);
  });

  it("never tells the owner about a pause the owner made, or one that resumes by itself", async () => {
    await setup();
    const task = w.h.majhi.services.tasks.get("ACM-1");
    w.h.majhi.services.tasks.cards.paused(task, "owner");
    w.h.majhi.services.tasks.cards.paused(task, "offline");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
  });

  it.each([
    ["loop", "ACM-1 stopped: the agents are going in circles"],
    ["blocked", "ACM-1 is blocked and waits for you"],
    ["error", "ACM-1 paused after an error"],
    ["limit", "ACM-1 paused: the account hit its usage limit"],
  ] as const)("sends one notification for a %s pause", async (reason, text) => {
    await setup();
    w.h.majhi.services.tasks.cards.paused(w.h.majhi.services.tasks.get("ACM-1"), reason);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "stopped", text });
  });

  it("groups a burst into one notification", async () => {
    await setup();
    for (const id of ["a1", "a2", "a3", "a4"]) approval(id);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "group", text: "4 decisions need you", count: 4, path: "/" });
    expect(desktop.map((m) => m.message)).toEqual(["4 decisions need you"]);
  });

  it("keeps three at the limit as three notifications", async () => {
    await setup();
    for (const id of ["a1", "a2", "a3"]) approval(id);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toHaveLength(3);
  });

  it("respects muted kinds and a channel that is off", async () => {
    await setup(NotificationsSettingsSchema.parse({ muted: ["approval"] }));
    approval("a1");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    notifier.close();
    vi.useRealTimers();
    await w.cleanup();

    await setup(NotificationsSettingsSchema.parse({ mac: false }));
    approval("a1");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toHaveLength(1);
    expect(desktop).toEqual([]);
  });

  it("leaves the desktop banner to a tab that reported it can pop browser notifications", async () => {
    await setup();
    const tab = {};
    hub.tabs.report(tab, true, Date.now());
    approval("a1");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toHaveLength(1);
    expect(desktop).toEqual([]);

    // A report older than a minute no longer counts: the tab may be gone.
    hub.tabs.report(tab, true, Date.now() - 61_000);
    approval("a2");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(desktop.map((n) => n.message)).toEqual(["ACM-1 needs approval: run migrations"]);
  });

  it("still sends the desktop banner when browser notifications are off, or the tab cannot pop", async () => {
    await setup(NotificationsSettingsSchema.parse({ browser: false }));
    hub.tabs.report({}, true, Date.now());
    approval("a1");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(desktop).toHaveLength(1);
    notifier.close();
    vi.useRealTimers();
    await w.cleanup();

    await setup();
    const tab = {};
    hub.tabs.report(tab, true, Date.now());
    hub.tabs.report(tab, false, Date.now());
    approval("a1");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(desktop).toHaveLength(1);
  });
});

describe("alerts are for decisions only", () => {
  it("tells a decision once by its id, whatever its card is called", async () => {
    await setup();
    approval("a1");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent.map((e) => e.id)).toEqual(["room:ACM-1:a1"]);
  });

  it("never alerts for a card the captain answers within its grace time", async () => {
    await setup();
    captainHandles = true;
    approval("a1");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    approval("a1", "applied");
    await vi.advanceTimersByTimeAsync(CAPTAIN_GRACE_MS + 1_000 + COLLECT_MS);
    expect(sent).toEqual([]);
  });

  it("alerts for a card the captain left, once its grace time is over", async () => {
    await setup();
    captainHandles = true;
    approval("a1");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(CAPTAIN_GRACE_MS + COLLECT_MS + 10);
    expect(sent).toHaveLength(1);
  });

  it("alerts for the captain's two questions, once each, and for nothing else it tells", async () => {
    await setup();
    notifier.captain("budget:day:2026-10-04", "Autonomous work used its $20 for today. Raise it?");
    notifier.captain("budget:day:2026-10-04", "again");
    notifier.captain("captain-cap:acme:memory:2026-10-04", "Acme: the memory chore reached its limit.");
    notifier.captain("captain-summary:2026-10-04", "Yesterday the captain did 4 things.");
    notifier.captain("captain:acme:2026-10-04T08:00:00Z", "Triage was turned off.");
    await vi.advanceTimersByTimeAsync(COLLECT_MS + 10);
    expect(sent.map((e) => e.path)).toEqual(["/limits", "/captain"]);
  });
});

describe("quiet hours", () => {
  const at = (iso: string) => Date.parse(iso);
  it("holds notifications inside a window that runs over midnight, in the saved zone", () => {
    const quiet = { from: "22:00", to: "07:00", tz: "UTC" };
    expect(inQuietHours(at("2026-10-01T23:30:00Z"), quiet)).toBe(true);
    expect(inQuietHours(at("2026-10-01T06:59:00Z"), quiet)).toBe(true);
    expect(inQuietHours(at("2026-10-01T07:00:00Z"), quiet)).toBe(false);
    expect(inQuietHours(at("2026-10-01T12:00:00Z"), quiet)).toBe(false);
    expect(inQuietHours(at("2026-10-01T23:30:00Z"), { ...quiet, tz: "Asia/Tokyo" })).toBe(false);
    expect(inQuietHours(at("2026-10-01T12:00:00Z"), {})).toBe(false);
  });
});

describe("the notifications list", () => {
  it("lists what waits in open tasks with its notification line, and drops answered items and done tasks", async () => {
    await setup();
    const { room, store } = w.h.majhi.services;
    approval("a1");
    room.post("ACM-1", "q1", {
      type: "choice",
      agent: "acme-builder",
      question: "Which queue should the export use?",
      options: [
        { id: "redis", label: "Redis" },
        { id: "sqs", label: "SQS" },
      ],
      state: "pending",
    });
    approval("a2", "applied");
    const list = async () => {
      const res = await w.h.cmd("notify.pending", {});
      expect(res.status).toBe(200);
      return res.body as { task: string; item: string; kind: string; text: string }[];
    };
    expect(await list()).toEqual([
      expect.objectContaining({
        task: "ACM-1",
        item: "a1",
        kind: "approval",
        text: "ACM-1 needs approval: run migrations",
      }),
      expect.objectContaining({
        task: "ACM-1",
        item: "q1",
        kind: "question",
        text: "ACM-1 needs a decision: Which queue should the export use?",
      }),
    ]);

    approval("a1", "applied");
    expect((await list()).map((n) => n.item)).toEqual(["q1"]);

    store.tasks.setStatus("ACM-1", "done", undefined, new Date().toISOString());
    expect(await list()).toEqual([]);
  });
});
