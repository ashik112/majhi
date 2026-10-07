import type { ChatCursor, ChatEnvelope } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatConnection, ChatSink } from "../adapter.ts";
import { FakeSlack } from "../testing/fake-slack.ts";
import { world } from "../testing/world.ts";
import { SlackAdapter } from "./adapter.ts";

/** The Slack adapter against a fake Slack: a repeat delivery stores once, and a gap is filled from the history. */

const CONN: ChatConnection = {
  id: "slack-acme",
  org: "acme",
  app: "slack",
  account: "Acme / majhi",
  token: FakeSlack.BOT_TOKEN,
  appToken: FakeSlack.APP_TOKEN,
  filesDir: "/tmp/majhi-chat-test",
};

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Gave up waiting for ${what}`);
}

let fake: FakeSlack | undefined;
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await fake?.close();
  fake = undefined;
});

async function slack(): Promise<FakeSlack> {
  const made = await new FakeSlack().listen();
  made.addUser({ id: "U1SARA", name: "sara", real_name: "Sara Khan" });
  made.addChannel({ id: "C1OPS", name: "acme-ops" });
  fake = made;
  return made;
}

/** The adapter wired to a real ingest: what it delivers is stored the way the hub stores it. */
function reader(api: FakeSlack) {
  const w = world();
  const adapter = new SlackAdapter({
    base: api.api,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  const saved: ChatCursor[] = [];
  const delivered: ChatEnvelope[] = [];
  const gaps: string[][] = [];
  const sink: ChatSink = {
    deliver: async (envelope) => {
      delivered.push(envelope);
      await w.ingest.deliver(CONN, envelope);
    },
    save: (cursor) => saved.push(cursor),
    trouble: () => undefined,
    unreachable: () => undefined,
    gap: (from, to) => gaps.push([from, to]),
  };
  const start = (cursor?: ChatCursor) => {
    const stop = adapter.start(CONN, sink, cursor);
    stops.push(stop);
    return stop;
  };
  const clientItems = (room: string) => w.store.room.page(room, 100).items.filter((i) => i.type === "client");
  return { w, start, saved, delivered, gaps, clientItems };
}

describe("the Slack adapter", () => {
  it("stores one item when Slack sends the same event again, and answers every envelope", async () => {
    const api = await slack();
    const r = reader(api);
    r.start();
    await until(() => api.socketCount === 1, "the socket");
    // The channel is new until the owner links it: its first message makes the New chat row.
    api.post({ channel: "C1OPS", user: "U1SARA", text: "hello" });
    await until(() => r.w.rooms.find("slack", CONN.account, "C1OPS") !== undefined, "the New chat");
    const room = r.w.rooms.find("slack", CONN.account, "C1OPS");
    if (room === undefined) throw new Error("no room");
    await r.w.rooms.link(room.id, "acme");

    const first = api.post({ channel: "C1OPS", user: "U1SARA", text: "Orders page is down" });
    await until(() => r.clientItems(room.id).length === 1, "the first item");
    api.redeliver(api.lastEvent());
    api.redeliver(api.lastEvent());
    // A reply in the thread of the first message comes in after the repeats, so they were all read by then.
    api.post({ channel: "C1OPS", user: "U1SARA", text: "still down", thread: first.ts });
    await until(() => r.clientItems(room.id).length === 2, "the thread reply");

    const items = r.clientItems(room.id);
    expect(items.map((i) => (i.type === "client" ? i.text : ""))).toEqual([
      "still down",
      "Orders page is down",
    ]);
    const reply = items[0];
    expect(reply?.type === "client" ? reply.thread : undefined).toBe(first.ts);
    // The repeat never reached the store, and each envelope was acknowledged.
    expect(r.delivered.filter((e) => e.text === "Orders page is down")).toHaveLength(1);
    await until(() => api.acks.length === api.events.length + 2, "the acknowledgements");
    expect(r.saved.at(-1)?.position.C1OPS).toBe(reply?.type === "client" ? reply.external.message : "");
  });

  it("fills a gap from the history from the read position, storing each message once", async () => {
    const api = await slack();
    const r = reader(api);
    const stop = r.start();
    await until(() => api.socketCount === 1, "the socket");
    api.post({ channel: "C1OPS", user: "U1SARA", text: "hello" });
    await until(() => r.w.rooms.find("slack", CONN.account, "C1OPS") !== undefined, "the New chat");
    const room = r.w.rooms.find("slack", CONN.account, "C1OPS");
    if (room === undefined) throw new Error("no room");
    await r.w.rooms.link(room.id, "acme");
    const root = api.post({ channel: "C1OPS", user: "U1SARA", text: "Checkout fails" });
    await until(() => r.clientItems(room.id).length === 1, "the first message");
    const cursor = r.saved.at(-1);
    expect(cursor?.position.C1OPS).toBe(root.ts);
    stop();

    // majhi is off for a while: Slack cannot send, and the client writes more, including in an older thread.
    api.holdEvents = true;
    api.post({ channel: "C1OPS", user: "U1SARA", text: "any news?", thread: root.ts });
    api.post({ channel: "C1OPS", user: "U1SARA", text: "it is urgent" });
    const before = api.called("conversations.history").length;

    r.start(cursor);
    await until(() => r.clientItems(room.id).length === 3, "the gap to fill");
    const asked = api.called("conversations.history").slice(before);
    // The history is read from the read position, and the thread of the last message is asked for what came after it.
    expect(asked).toHaveLength(1);
    expect(api.called("conversations.replies").at(-1)?.params).toMatchObject({
      ts: root.ts,
      oldest: root.ts,
    });
    expect(
      r
        .clientItems(room.id)
        .map((i) => (i.type === "client" ? i.text : ""))
        .toSorted(),
    ).toEqual(["Checkout fails", "any news?", "it is urgent"]);

    // Asking again from the same old position stores nothing twice.
    const again = reader(api);
    again.start(cursor);
    await until(() => again.saved.length > 0, "the second catch-up");
    expect(r.clientItems(room.id)).toHaveLength(3);
    expect(r.gaps).toEqual([]);
  });
});
