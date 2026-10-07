import { afterEach, expect, it } from "vitest";
import { ChatHub } from "../hub.ts";
import { ClientChat } from "../service.ts";
import { FakeSlack } from "../testing/fake-slack.ts";
import { world } from "../testing/world.ts";
import { SlackAdapter } from "./adapter.ts";

/** Linking from the channel list: a public channel is joined and then linked as a New chat is; a private one is not joined. */

let fake: FakeSlack | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

it("joins a public channel then links it through the New chats path, and never joins a private one", async () => {
  fake = await new FakeSlack().listen();
  fake.addChannel({ id: "C2PUB", name: "acme-support", member: false });
  fake.addChannel({ id: "C3PRIV", name: "acme-private", member: false, private: true });
  const w = world();
  const info = { id: "slack-acme", org: "acme", app: "slack" as const, account: "Acme / majhi" };
  const hub = new ChatHub({
    adapters: [new SlackAdapter({ base: fake.api })],
    connections: async () => [info],
    tokens: async () => ({ token: FakeSlack.BOT_TOKEN, appToken: FakeSlack.APP_TOKEN }),
    majhiHome: "/tmp/majhi-chat-home",
    cursors: { get: () => undefined, set: () => undefined },
    deliver: async () => undefined,
    gap: () => undefined,
    unreachable: () => undefined,
    polling: false,
    changed: () => undefined,
  });
  const chat = new ClientChat({
    store: w.store,
    room: w.room,
    rooms: w.rooms,
    contacts: w.contacts,
    replies: w.replies,
    ingest: w.ingest,
    hub,
    connections: async () => [info],
    savedHolds: async () => undefined,
    tell: async () => "ask",
    lane: async () => undefined,
    deleteWebhook: async () => undefined,
  });

  const row = await chat.channelLink("slack-acme", "C2PUB", "acme");
  expect(fake.called("conversations.join").map((c) => c.params.channel)).toEqual(["C2PUB"]);
  expect(row).toMatchObject({ title: "#acme-support", org: "acme" });
  expect(w.rooms.list().clients.map((r) => r.id)).toEqual([row.id]);
  expect(w.rooms.find("slack", info.account, "C2PUB")?.org).toBe("acme");

  await expect(chat.channelLink("slack-acme", "C3PRIV", "acme")).rejects.toThrow("/invite @majhi");
  expect(fake.called("conversations.join")).toHaveLength(1);
  expect(w.rooms.find("slack", info.account, "C3PRIV")).toBeUndefined();
});
