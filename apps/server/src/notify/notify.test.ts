import { type AttentionEvent, NotificationsSettingsSchema, type ServerEvent } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../events/hub.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { inQuietHours } from "./attention.ts";
import { COLLECT_MS, type MacNotice, Notifier, SETTLE_MS } from "./service.ts";

let w: World;
let notifier: Notifier;
let sent: AttentionEvent[];
let mac: MacNotice[];

const SETTLED = SETTLE_MS + COLLECT_MS + 10;

async function setup(settings = NotificationsSettingsSchema.parse({})): Promise<void> {
  w = await taskWorld();
  expect(
    (await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: false }))
      .status,
  ).toBe(200);
  const { store, room } = w.h.majhi.services;
  const hub = new EventHub();
  sent = [];
  mac = [];
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
    events: hub,
    mac: async (n) => {
      mac.push(n);
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
    expect(mac).toEqual([
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
    expect(mac).toEqual([]);
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
    expect(sent[0]).toMatchObject({ kind: "group", text: "4 things need you", count: 4, path: "/" });
    expect(mac.map((m) => m.message)).toEqual(["4 things need you"]);
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
    expect(mac).toEqual([]);
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
