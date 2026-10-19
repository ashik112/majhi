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
});
