import { type AttentionEvent, NotificationsSettingsSchema, type ServerEvent } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../events/hub.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { COLLECT_MS, type DesktopNotice, Notifier, SETTLE_MS } from "./service.ts";

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
  it("sends exactly one notification for an approval, even when the card is written again", async () => {
    await setup();
    approval("a1");
    approval("a1");
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "approval", task: "ACM-1", count: 1 });
    expect(desktop).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
  });
});
