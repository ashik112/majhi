import { describe, expect, it } from "vitest";
import { CONN, envelope, world } from "./testing/world.ts";

/** Test 1: the same delivery twice stores one item; an edit changes the item and keeps what it said before. */

describe("a delivery of a chat app", () => {
  it("stores once however often it arrives", async () => {
    const w = world();
    const room = await w.linked();
    const again = envelope({ message: "7", text: "Is the fix live?" });
    await w.ingest.deliver(CONN, again);
    await w.ingest.deliver(CONN, again);
    await w.ingest.deliver(CONN, { ...again, at: new Date().toISOString() });
    const items = w.store.room.page(room, 50).items.filter((i) => i.type === "client");
    expect(items.map((i) => (i.type === "client" ? i.text : ""))).toEqual(["Is the fix live?"]);
  });

  it("keeps the earlier words of an edited message and does not triage the edit again", async () => {
    const w = world();
    const room = await w.linked();
    await w.ingest.deliver(CONN, envelope({ message: "8", text: "The page is slow" }));
    await w.ingest.deliver(CONN, envelope({ message: "8", kind: "edit", text: "The page is down" }));
    await w.ingest.deliver(CONN, envelope({ message: "8", kind: "edit", text: "The page is down" }));
    const items = w.store.room.page(room, 50).items.filter((i) => i.type === "client");
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.type === "client" && item.text).toBe("The page is down");
    expect(item?.type === "client" && item.revisions.map((r) => r.text)).toEqual(["The page is slow"]);
    await w.ingest.idle();
    expect(w.triaged.map((i) => (i.type === "client" ? i.text : ""))).toEqual(["The page is slow"]);
  });

  it("stores nothing from a chat nobody linked, another bot or a stranger's private chat", async () => {
    const w = world();
    await w.ingest.deliver(CONN, envelope({ chatId: "-200", message: "1", text: "hello from a new group" }));
    const fresh = w.rooms.find("telegram", CONN.account, "-200");
    expect(fresh?.org).toBeUndefined();
    expect(w.store.room.page(fresh?.id ?? "", 10).items).toEqual([]);
    expect(w.rooms.list().newChats.map((r) => r.id)).toEqual([fresh?.id]);
    await w.ingest.deliver(
      CONN,
      envelope({ chatId: "55", message: "1", chat: { title: "Sara", kind: "private" }, text: "buy now" }),
    );
    expect(w.rooms.find("telegram", CONN.account, "55")).toBeUndefined();
    const room = await w.linked("-300");
    await w.ingest.deliver(CONN, envelope({ chatId: "-300", message: "5", text: "A real question" }));
    await w.ingest.deliver(
      CONN,
      envelope({
        chatId: "-300",
        message: "2",
        sender: { id: "b1", name: "Bot", bot: true, verified: true },
      }),
    );
    expect(w.store.room.page(room, 10).items.filter((i) => i.type === "client")).toHaveLength(1);
  });

  it("takes the owner's own message as the owner's: the holder becomes You and it is never triaged as a client", async () => {
    const w = world();
    const room = await w.linked();
    await w.ingest.deliver(
      CONN,
      envelope({
        message: "20",
        owner: true,
        sender: { id: "u-owner", name: "Owner Acme", bot: false, verified: true },
        text: "I will look at the orders page",
      }),
    );
    await w.ingest.idle();
    expect(w.triaged).toEqual([]);
    expect(w.store.client.room(room)?.chat.holder).toBe("you");
    const contact = w.store.client.byIdentity("acme", {
      app: "telegram",
      account: CONN.account,
      native: "u-owner",
    });
    expect(contact?.us).toBe(true);
  });

  it("asks once whether an admin nobody marked is one of us, and reads their message only if the answer is client", async () => {
    const w = world();
    const room = await w.linked();
    const admin = { id: "u-admin", name: "Dana", bot: false, verified: true, staff: true };
    await w.ingest.deliver(
      CONN,
      envelope({ message: "30", sender: admin, text: "Checking the orders page" }),
    );
    await w.ingest.deliver(CONN, envelope({ message: "31", sender: admin, text: "Still checking" }));
    await w.ingest.idle();
    expect(w.triaged).toEqual([]);
    const cards = w.store.room.page(room, 50).items.filter((i) => i.type === "who-is");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ sender: "u-admin", state: "asking" });
    await w.ingest.settleWaiting(room, "u-admin", false);
    expect(w.triaged.map((i) => (i.type === "client" ? i.text : ""))).toEqual([
      "Checking the orders page",
      "Still checking",
    ]);
  });
});
