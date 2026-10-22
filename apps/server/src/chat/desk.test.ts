import type { RoomItem, Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { ChatDesk } from "./desk.ts";
import { writeOutcome } from "./outcome.ts";
import { CONN, envelope, world } from "./testing/world.ts";

const LANE = "ACM-1";

/** A client message the captain was woken with, and a lane task in `status`. */
async function woken(status: Task["status"]) {
  const w = world();
  const room = await w.linked();
  await w.ingest.deliver(CONN, envelope({ message: "9" }));
  w.store.tasks.insert({
    id: LANE,
    title: "Captain lane",
    brief: "lane",
    kind: "chat",
    org: "acme",
    status,
    folder: "/Users/owner/work/.majhi/ACM-1",
    repos: [],
    team: ["captain"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as Task);
  const outcome = () => {
    const item = w.store.room.page(room, 10).items.find((i: RoomItem) => i.type === "client");
    return item?.type === "client" ? item.outcome : undefined;
  };
  const first = w.store.room.page(room, 10).items.find((i: RoomItem) => i.type === "client");
  if (first?.type !== "client") throw new Error("no client message");
  writeOutcome(w, room, first, { state: "working" });
  const desk = new ChatDesk({
    store: w.store,
    room: w.room,
    wake: async () => ({ sent: true, chat: LANE }),
    changed: () => undefined,
    debounceMs: 0,
  });
  const row = w.store.client.room(room);
  if (row === undefined) throw new Error("no room");
  desk.add(row, first);
  await desk.flush(room);
  return { w, desk, outcome, room };
}

describe("a client message the captain was woken with", () => {
  it("waits, urgent, when the lane stopped without a turn that ended", async () => {
    const t = await woken("paused");
    t.desk.settle([LANE]);
    expect(t.outcome()).toMatchObject({ state: "waits", urgent: true });
    expect(t.outcome()?.why?.startsWith("Not answered: the captain could not start (")).toBe(true);
  });

  it("is not urgent any more once the lane runs again and handles it", async () => {
    const t = await woken("paused");
    t.desk.settle([LANE]);
    t.w.store.raw.prepare("update tasks set status = 'running' where id = ?").run(LANE);
    t.desk.settle([LANE]);
    await t.desk.flush(t.room);
    expect(t.outcome()).toMatchObject({ state: "working" });
    t.w.store.raw.prepare("update tasks set status = 'review' where id = ?").run(LANE);
    t.desk.turnEnded(LANE);
    t.desk.settle([LANE]);
    expect(t.outcome()).toMatchObject({ state: "handled" });
    expect(t.outcome()?.urgent).toBeUndefined();
  });

  it("is handled when the lane's turn ran and ended with no reply", async () => {
    const t = await woken("review");
    t.desk.turnEnded(LANE);
    t.desk.settle([LANE]);
    expect(t.outcome()).toMatchObject({ state: "handled" });
  });
});
