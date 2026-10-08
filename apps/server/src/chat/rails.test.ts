import type { Draft, ReplyFlags } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { CONN, envelope, world } from "./testing/world.ts";

/**
 * Test 3: the rails. Under Tell "Ask me" no reply is sent; under "Captain decides" a held class waits; a secret, another
 * client's name and a report always wait;.
 */

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";

async function ready(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  const room = await w.linked();
  await w.ingest.deliver(CONN, envelope({ message: "9", text: "Any update?" }));
  const reply = (text: string, flags: ReplyFlags | null = w.flags()) =>
    w.replies.captain({ room, text, flags: flags ?? undefined, to: "u1", replyTo: "9" });
  const drafts = (): Draft[] => w.gate.list("acme");
  return { w, room, reply, drafts };
}

describe("a reply to a client", () => {
  it("never goes out under Tell Ask me, however clear it is", async () => {
    const t = await ready({ tell: "ask", holds: { firstContact: false } });
    const out = await t.reply("The fix is live.");
    expect(out).toMatchObject({ state: "held", why: "tell" });
    expect(t.w.sent).toEqual([]);
    expect(t.drafts().map((d) => d.status)).toEqual(["pending"]);
    const item = t.w.store.room.get(t.room, `reply:${t.drafts()[0]?.id}`);
    expect(item).toMatchObject({ type: "client-reply", state: "held", hold: "tell", by: "captain" });
  });

  it("goes out under Captain decides when nothing holds it, to the same chat, thread and message", async () => {
    const t = await ready({ tell: "decide", holds: { firstContact: false } });
    const out = await t.reply("The fix is live.");
    expect(out.state).toBe("sent");
    expect(t.w.sent).toEqual([{ chat: "-100", text: "The fix is live.", thread: undefined, replyTo: "9" }]);
    expect(t.drafts().map((d) => d.status)).toEqual(["sent"]);
  });

  it("waits when a class of the Hold list holds it, and goes when the owner switched that class off", async () => {
    const cases: [string, Partial<ReplyFlags>, string][] = [
      ["promisedTime", { promisedTime: true }, "promisedTime"],
      ["money", { money: true }, "money"],
      ["security", { security: true }, "security"],
      ["severalClients", { severalClients: true }, "severalClients"],
    ];
    for (const [name, flags, why] of cases) {
      const held = await ready({ tell: "decide", holds: { firstContact: false } });
      const out = await held.reply("We will fix it by 10:35.", held.w.flags(flags));
      expect(out, name).toMatchObject({ state: "held", why });
      expect(held.w.sent, name).toEqual([]);
      const off = await ready({ tell: "decide", holds: { firstContact: false, [name]: false } });
      expect((await off.reply("We will fix it by 10:35.", off.w.flags(flags))).state, name).toBe("sent");
    }
  });

  it("waits for the first message to a contact, and after a gap in delivery", async () => {
    const first = await ready({ tell: "decide" });
    expect(await first.reply("Hello Sara.")).toMatchObject({ state: "held", why: "firstContact" });
    expect(first.w.sent).toEqual([]);

    const gap = await ready({ tell: "decide", holds: { firstContact: false } });
    gap.w.room.post(gap.room as never, "gap:1", {
      type: "client-gap",
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-03T00:00:00Z",
    });
    expect(await gap.reply("Back online.")).toMatchObject({ state: "held", why: "afterGap" });
    // The owner writes in the chat: the gap is dealt with.
    await gap.w.replies.owner({ room: gap.room, text: "Sorry for the silence." });
    gap.w.rooms.holder(gap.room, "captain");
    expect(await gap.reply("The fix is live.")).toMatchObject({ state: "sent" });
  });

  it("waits when the writer gave no answer for its flags", async () => {
    const t = await ready({ tell: "decide", holds: { firstContact: false } });
    expect(await t.reply("Done.", null)).toMatchObject({ state: "held", why: "unchecked" });
    expect(t.w.sent).toEqual([]);
  });

  it("always waits with a secret, which is taken out of what the owner is shown, and no switch changes that", async () => {
    const t = await ready({
      tell: "decide",
      holds: {
        firstContact: false,
        promisedTime: false,
        money: false,
        security: false,
        severalClients: false,
        afterGap: false,
      },
    });
    const out = await t.reply(`Use this key ${SECRET} to log in.`);
    expect(out).toMatchObject({ state: "held", why: "secret" });
    expect(t.w.sent).toEqual([]);
    const draft = t.drafts()[0];
    expect(draft?.body).not.toContain(SECRET);
    expect(JSON.stringify(t.w.store.room.page(t.room, 50).items)).not.toContain(SECRET);
    // The owner cannot send it back with the secret in: the gate refuses an edit that holds one.
    expect(() => t.w.replies.edit(draft?.id ?? 0, `Use ${SECRET}`)).toThrow(/secret/);
  });

  it("always waits when it names another client or another workspace", async () => {
    const t = await ready({ tell: "decide", holds: { firstContact: false } });
    await t.w.ingest.deliver(
      CONN,
      envelope({ chatId: "-555", message: "1", chat: { title: "Northwind helpdesk", kind: "group" } }),
    );
    expect(await t.reply("Same fix as for Northwind helpdesk.")).toMatchObject({
      state: "held",
      why: "other-client",
    });
    expect(await t.reply("Globex had this too.")).toMatchObject({ state: "held", why: "other-client" });
    expect(await t.reply("globexample is not a name here.")).toMatchObject({ state: "sent" });
    expect(t.w.sent).toHaveLength(1);
  });

  it("always waits when it is a report, like an RCA", async () => {
    const t = await ready({ tell: "decide", holds: { firstContact: false } });
    const out = await t.w.replies.captain({
      room: t.room,
      text: "What happened and why.",
      flags: t.w.flags(),
      to: "u1",
      report: true,
    });
    expect(out).toMatchObject({ state: "held", why: "report" });
    expect(t.w.sent).toEqual([]);
  });

  it("is not written by the captain in a chat the owner holds", async () => {
    const t = await ready({ tell: "decide", holds: { firstContact: false } });
    t.w.rooms.holder(t.room, "you");
    await expect(t.reply("Hi.")).rejects.toThrow(/hold this chat/);
    expect(t.w.sent).toEqual([]);
  });

  it("is sent when the owner approves it, and what the owner edited is what goes", async () => {
    const t = await ready({ tell: "ask", holds: { firstContact: false } });
    await t.reply("The fix is live.");
    const draft = t.drafts()[0];
    t.w.replies.edit(draft?.id ?? 0, "The fix is live and holding.");
    await t.w.gate.decide(draft?.id ?? 0, "send");
    expect(t.w.sent.map((s) => s.text)).toEqual(["The fix is live and holding."]);
    expect(t.w.store.room.get(t.room, `reply:${draft?.id}`)).toMatchObject({
      state: "sent",
      text: "The fix is live and holding.",
    });
  });
});
