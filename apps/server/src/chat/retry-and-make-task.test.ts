import type { TaskId } from "@majhi/shared";
import { afterEach, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { CONN, envelope, world } from "./testing/world.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

it("Make a task from a client message opens the task in the room's workspace and refuses a message of another room", async () => {
  w = await bossWorld();
  const { h } = w;
  const { chatParts } = h.majhi.services;
  await chatParts.ingest.deliver(CONN, envelope({ message: "1", chatId: "-100", text: "Please add a CSV export" }));
  await chatParts.ingest.deliver(CONN, envelope({ message: "1", chatId: "-200", text: "Other room secret plan" }));
  const first = chatParts.rooms.find("telegram", CONN.account, "-100");
  const second = chatParts.rooms.find("telegram", CONN.account, "-200");
  if (first === undefined || second === undefined) throw new Error("no rooms");
  await chatParts.rooms.link(first.id, "acme");
  await chatParts.rooms.link(second.id, "acme");
  const items = (room: string) => h.majhi.services.store.room.page(room, 20).items;
  const mine = items(first.id).find((i) => i.type === "client");
  const theirs = items(second.id).find((i) => i.type === "client");
  if (mine === undefined || theirs === undefined) throw new Error("no messages");

  const refused = await h.cmd("chat.makeTask", { room: first.id, item: theirs.id });
  expect(refused.status).toBe(404);
  expect(h.majhi.services.store.tasks.list(false).filter((t) => t.origin?.kind === "client")).toHaveLength(0);

  const made = await h.cmd("chat.makeTask", { room: first.id, item: mine.id });
  expect(made.status).toBe(200);
  const task = h.majhi.services.store.tasks.list(false).find((t) => t.origin?.kind === "client");
  expect(task?.org).toBe("acme");
  expect(task?.origin).toMatchObject({ kind: "client", room: first.id, item: mine.id });
  expect(items(first.id).find((i) => i.id === mine.id)).toMatchObject({ outcome: { task: task?.id } });
}, 60_000);

it("Retry of a failed reply goes through the same holds as a first send", async () => {
  const x = world({ tell: "decide", failSend: true, holds: { firstContact: false, afterGap: false } });
  const room = await x.linked();
  const first = await x.replies.captain({ room, text: "We are on it.", flags: x.flags() });
  expect(first.state).toBe("failed");
  const failed = x.store.room.page(room, 10).items.find((i) => i.type === "client-reply");
  if (failed === undefined) throw new Error("no reply");

  // The owner turned Tell to Ask me since: the retry waits instead of going.
  x.state.tell = "ask";
  const again = await x.replies.retry(room, failed.id);
  expect(again.state).toBe("held");
  expect(x.sent).toHaveLength(0);
  expect(x.store.room.get(room, failed.id)).toMatchObject({ state: "discarded" });
});

it("Retry of a failed message that holds a secret is refused", async () => {
  const x = world({ failSend: true });
  const room = await x.linked();
  x.room.post(room as TaskId, "reply:9", {
    type: "client-reply",
    by: "you",
    text: "The key is AKIAIOSFODNN7EXAMPLE",
    state: "failed",
    draft: 9,
  });
  await expect(x.replies.retry(room, "reply:9")).rejects.toThrow(/secret/);
  expect(x.sent).toHaveLength(0);
});
