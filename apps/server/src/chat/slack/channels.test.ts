import { afterEach, expect, it } from "vitest";
import { parseBody } from "../format.ts";
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

function setup(fake: FakeSlack) {
  const w = world();
  const info = { id: "slack-acme", org: "acme", app: "slack" as const, account: "Acme / majhi" };
  const hub = new ChatHub({
    adapters: [new SlackAdapter({ base: fake.api })],
    connections: async () => [info],
    tokens: async () => ({ token: FakeSlack.BOT_TOKEN, appToken: FakeSlack.APP_TOKEN }),
    majhiHome: "/tmp/majhi-chat-home",
    cursors: { get: () => undefined, set: () => undefined },
    notes: {
      get: (c) => {
        const cursor = w.store.client.cursor(c);
        return { needed: cursor?.needed ?? [], eventSeen: cursor?.eventSeen === true };
      },
      set: (c, notes) => w.store.client.setNotes(c, notes, new Date().toISOString()),
    },
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
    settings: w.settings,
    captain: {} as never,
    hub,
    connections: async () => [info],
    savedHolds: async () => undefined,
    tell: async () => "ask",
    lane: async () => undefined,
    deleteWebhook: async () => undefined,
    saveUserToken: async () => undefined,
  });
  return { hub, chat, info };
}

it("shows a permission as not confirmed when Slack does not say, and as missing once Slack refused a call for it", async () => {
  fake = await new FakeSlack().listen();
  fake.addChannel({ id: "C1", name: "acme-ops" });
  fake.scopes = fake.scopes.filter((s) => s !== "chat:write");
  fake.hideScopes = true;
  const { hub, chat, info } = setup(fake);
  const states = async () =>
    Object.fromEntries((await chat.channels("slack-acme", true)).permissions.map((p) => [p.scope, p.state]));

  expect((await states())["chat:write"]).toBe("unknown");
  expect((await states())["channels:read"]).toBe("unknown");

  await expect(
    hub.send("slack", info.account, { chat: "C1" }, { body: parseBody("hi"), people: () => undefined }),
  ).rejects.toThrow("Slack needs chat:write");
  expect((await states())["chat:write"]).toBe("missing");
  expect((await states())["channels:read"]).toBe("unknown");

  // Slack tells the scopes again, and the recorded refusal is cleared by what it says.
  fake.hideScopes = false;
  fake.scopes.push("chat:write");
  const after = await states();
  expect(after["chat:write"]).toBe("granted");
  fake.hideScopes = true;
  expect((await states())["chat:write"]).toBe("unknown");
});

it("shows the scopes Slack lists as granted or missing", async () => {
  fake = await new FakeSlack().listen();
  fake.scopes = fake.scopes.filter((s) => s !== "chat:write");
  const { chat } = setup(fake);
  const got = await chat.channels("slack-acme", true);
  expect(got.permissions.find((p) => p.scope === "chat:write")?.state).toBe("missing");
  expect(got.permissions.find((p) => p.scope === "files:read")?.state).toBe("granted");
  expect(JSON.parse(got.manifest).oauth_config.scopes.bot).toContain("chat:write");
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
    settings: w.settings,
    captain: {} as never,
    hub,
    connections: async () => [info],
    savedHolds: async () => undefined,
    tell: async () => "ask",
    lane: async () => undefined,
    deleteWebhook: async () => undefined,
    saveUserToken: async () => undefined,
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
