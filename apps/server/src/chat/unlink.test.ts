import { expect, it } from "vitest";
import { CONN, envelope, world } from "./testing/world.ts";

/** Unlinking a chat stops triage and replies for it, keeps its history under its workspace, and a relink is a fresh room. */

it("stops triage after an unlink, and a relink to another workspace never shows the old history", async () => {
  const w = world();
  const old = await w.linked();
  await w.ingest.deliver(CONN, envelope({ message: "1", text: "Acme secret roadmap" }));
  await w.ingest.idle();
  expect(w.triaged).toHaveLength(1);

  w.rooms.unlink(old);
  await w.ingest.deliver(CONN, envelope({ message: "2", text: "Written after the unlink" }));
  await w.ingest.idle();
  expect(w.triaged).toHaveLength(1);
  await expect(w.replies.owner({ room: old, text: "hello", replyTo: undefined })).rejects.toThrow("unlinked");
  expect(w.sent).toEqual([]);

  // The chat is a New chat again; linking it to Globex makes a new room.
  const fresh = w.rooms.find("telegram", CONN.account, "-100");
  expect(fresh?.id).toBeDefined();
  expect(fresh?.id).not.toBe(old);
  await w.rooms.link(fresh?.id ?? "", "globex");
  const texts = (id: string) =>
    w.store.room.page(id, 50).items.flatMap((i) => (i.type === "client" ? [i.text] : []));
  expect(texts(fresh?.id ?? "")).toEqual([]);
  expect(texts(old)).toEqual(["Acme secret roadmap"]);
  expect(w.store.client.room(old)).toMatchObject({ org: "acme", chat: { archived: true } });
  expect(w.store.client.room(fresh?.id ?? "")?.org).toBe("globex");

  await w.ingest.deliver(CONN, envelope({ message: "3", text: "Globex question" }));
  await w.ingest.idle();
  expect(texts(fresh?.id ?? "")).toEqual(["Globex question"]);
  expect(texts(old)).not.toContain("Globex question");
});

it("an ignored chat is watched again", async () => {
  const w = world();
  await w.ingest.deliver(CONN, envelope({ chatId: "-200", message: "1" }));
  const room = w.rooms.find("telegram", CONN.account, "-200");
  w.rooms.ignore(room?.id ?? "");
  expect(w.rooms.list().newChats).toEqual([]);
  w.rooms.unignore(room?.id ?? "");
  expect(w.rooms.list().newChats.map((r) => r.id)).toEqual([room?.id]);
});

it("discards the replies that waited for the owner when the chat is unlinked, and sends none of them", async () => {
  const w = world({ tell: "ask" });
  const room = await w.linked();
  await w.ingest.deliver(CONN, envelope({ message: "5", text: "Is the fix live?" }));
  const held = await w.replies.captain({
    room,
    text: "The fix is live.",
    flags: w.flags(),
    to: "u1",
    replyTo: "5",
  });
  expect(held.state).toBe("held");
  expect(w.gate.pending()).toHaveLength(1);

  w.rooms.unlink(room);
  expect(await w.replies.discardPending(room)).toBe(1);
  expect(w.gate.pending()).toEqual([]);
  expect(w.sent).toEqual([]);
  const reply = w.store.room.page(room, 20).items.find((i) => i.type === "client-reply");
  expect(reply).toMatchObject({ state: "discarded" });
});

it("links an unlinked chat to the same workspace again as the same room, with its history, and makes no second row", async () => {
  const w = world();
  const old = await w.linked();
  await w.ingest.deliver(CONN, envelope({ message: "1", text: "Acme secret roadmap" }));
  w.rooms.unlink(old);
  await w.ingest.deliver(CONN, envelope({ message: "2", text: "Written while unlinked" }));
  const fresh = w.rooms.find("telegram", CONN.account, "-100");
  expect(fresh?.id).not.toBe(old);

  const back = await w.rooms.link(fresh?.id ?? "", "acme");
  expect(back.id).toBe(old);
  expect(w.store.client.room(fresh?.id ?? "")).toBeUndefined();
  expect(w.rooms.find("telegram", CONN.account, "-100")?.id).toBe(old);
  const texts = w.store.room
    .page(old, 50)
    .items.flatMap((i) => (i.type === "client" ? [i.text] : []))
    .toReversed();
  expect(texts).toEqual(["Acme secret roadmap"]);
  expect(w.rooms.list().clients.map((r) => r.id)).toEqual([old]);
  expect(w.rooms.list().newChats).toEqual([]);
});
