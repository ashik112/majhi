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
  it.each<[string, () => Promise<void>]>([
    [
      "under Tell Ask me, however clear it is",
      async () => {
        const t = await ready({ tell: "ask", holds: { firstContact: false } });
        const out = await t.reply("The fix is live.");
        expect(out).toMatchObject({ state: "held", why: "tell" });
        expect(t.w.sent).toEqual([]);
        expect(t.drafts().map((d) => d.status)).toEqual(["pending"]);
        const item = t.w.store.room.get(t.room, `reply:${t.drafts()[0]?.id}`);
        expect(item).toMatchObject({ type: "client-reply", state: "held", hold: "tell", by: "captain" });
      },
    ],
    [
      "with a secret, which is taken out of what the owner is shown, whatever the switches say",
      async () => {
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
      },
    ],
    [
      "when it names another client or another workspace",
      async () => {
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
        expect(t.w.sent).toEqual([]);
      },
    ],
    [
      "when it is a report, like an RCA",
      async () => {
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
      },
    ],
    [
      "for the first message to a contact",
      async () => {
        const first = await ready({ tell: "decide" });
        expect(await first.reply("Hello Sara.")).toMatchObject({ state: "held", why: "firstContact" });
        expect(first.w.sent).toEqual([]);
      },
    ],
  ])("waits for the owner: %s", async (_name, run) => {
    await run();
  });
});
