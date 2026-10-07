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
