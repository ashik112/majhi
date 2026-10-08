import type { ChatEnvelope } from "@majhi/shared";
import { afterEach, expect, it } from "vitest";
import { OutboundGate } from "../../playbooks/outbound.ts";
import { ChatHub } from "../hub.ts";
import { ClientReplies } from "../replies.ts";
import { FakeSlack } from "../testing/fake-slack.ts";
import { world } from "../testing/world.ts";
import { SlackAdapter } from "./adapter.ts";

/** Send as Me: replies go out under the owner's own token, majhi's own posts are never read back as clients, and the owner's own words are "us". */

let fake: FakeSlack | undefined;
const hubs: ChatHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.stop();
  await fake?.close();
  fake = undefined;
});

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Gave up waiting for ${what}`);
}

async function setup() {
  const api = await new FakeSlack().listen();
  fake = api;
  api.addUser({ id: "U1SARA", name: "sara", real_name: "Sara Khan" });
  api.addChannel({ id: "C1OPS", name: "acme-ops" });
  const w = world({ tell: "decide", holds: { firstContact: false } });
  const info = {
    id: "slack-acme",
    org: "acme",
    app: "slack" as const,
    account: "Acme / majhi",
  };
  const delivered: ChatEnvelope[] = [];
  const hub = new ChatHub({
    adapters: [new SlackAdapter({ base: api.api })],
    connections: async () => [info],
    tokens: async () => ({
      token: FakeSlack.BOT_TOKEN,
      appToken: FakeSlack.APP_TOKEN,
      userToken: FakeSlack.USER_TOKEN,
    }),
    majhiHome: "/tmp/majhi-chat-home",
    cursors: { get: () => undefined, set: () => undefined },
    deliver: async (conn, envelope) => {
      delivered.push(envelope);
      await w.ingest.deliver(conn, envelope);
    },
    gap: () => undefined,
    unreachable: () => undefined,
    polling: true,
    changed: () => undefined,
  });
  hubs.push(hub);
  let replies: ClientReplies | undefined;
  const gate = new OutboundGate({
    db: w.store.raw,
    tz: async () => "UTC",
    knownOrg: async () => true,
    transports: {
      client: { send: async (draft) => replies?.transport.send(draft) ?? { ok: false, detail: "not ready" } },
    },
    settled: (draft) => replies?.settled(draft),
  });
  replies = new ClientReplies({
    store: w.store,
    room: w.room,
    gate,
    hub,
    rooms: w.rooms,
    tell: async () => "decide",
    holds: async () => ({
      promisedTime: true,
      firstContact: false,
      severalClients: true,
      afterGap: true,
      money: true,
      security: true,
    }),
    orgNames: async () => new Map([["acme", "Acme"]]),
    changed: () => undefined,
  });
  await hub.sync();
  await until(() => api.socketCount === 1, "the socket");
  // The channel is a New chat until the owner links it.
  api.post({ channel: "C1OPS", user: "U1SARA", text: "hello" });
  await until(() => w.rooms.find("slack", info.account, "C1OPS") !== undefined, "the New chat");
  const room = w.rooms.find("slack", info.account, "C1OPS");
  if (room === undefined) throw new Error("no room");
  await w.rooms.link(room.id, "acme");
  w.rooms.sendAs(room.id, "me");
  const items = () => w.store.room.page(room.id, 100).items;
  return { api, w, room, replies, delivered, items };
}

it("sends the captain's reply with the owner's token, and its echo is not read as a client or as the owner typing", async () => {
  const t = await setup();
  const ask = t.api.post({ channel: "C1OPS", user: "U1SARA", text: "Orders page is down" });
  await until(() => t.w.triaged.length === 1, "the first triage");
  const out = await t.replies.captain({
    room: t.room.id,
    text: "On it, looking now.",
    flags: t.w.flags(),
    to: "U1SARA",
    replyTo: ask.ts,
  });
  expect(out.state).toBe("sent");
  expect(t.api.sent).toHaveLength(1);
  expect(t.api.sent[0]).toMatchObject({ by: "owner", text: "On it, looking now." });
  expect(t.api.called("chat.postMessage").at(-1)?.token).toBe(FakeSlack.USER_TOKEN);
  // The echo came back over the socket; a later message from the client is read after it.
  t.api.post({ channel: "C1OPS", user: "U1SARA", text: "Thanks" });
  await until(() => t.w.triaged.length === 2, "the second triage");
  expect(t.delivered.filter((e) => e.sender.id === "U0OWNER")).toEqual([]);
  expect(t.w.triaged.map((i) => (i.type === "client" ? i.text : ""))).toEqual([
    "Orders page is down",
    "Thanks",
  ]);
  expect(t.w.rooms.room(t.room.id).chat.holder).toBe("captain");
  expect(t.items().filter((i) => i.type === "client").length).toBe(3);
  const reply = t.items().find((i) => i.type === "client-reply");
  expect(reply).toMatchObject({ by: "captain", as: "you", state: "sent" });
});

it("takes a message the owner typed in Slack as ours: the room goes to You and nothing is triaged", async () => {
  const t = await setup();
  t.api.post({ channel: "C1OPS", user: "U0OWNER", text: "I will take this one" });
  await until(() => t.items().some((i) => i.type === "client" && i.us === true), "the owner's message");
  expect(t.delivered.at(-1)).toMatchObject({ owner: true });
  expect(t.w.rooms.room(t.room.id).chat.holder).toBe("you");
  expect(t.w.triaged).toEqual([]);
});

it("counts a client's mention of the owner as addressed", async () => {
  const t = await setup();
  t.api.post({ channel: "C1OPS", user: "U1SARA", text: "<@U0OWNER> are you there?" });
  await until(() => t.w.triaged.length === 1, "the triage");
  expect(t.delivered.at(-1)?.addressed).toBe(true);
  expect(t.w.triaged[0]).toMatchObject({ type: "client", addressed: true });
});

it("never posts a Me chat's reply as the bot when the owner's token is refused: it does not go and says what to fix", async () => {
  const t = await setup();
  t.api.userTokenValid = false;
  const ask = t.api.post({ channel: "C1OPS", user: "U1SARA", text: "Orders page is down" });
  await until(() => t.w.triaged.length === 1, "the triage");
  const out = await t.replies.captain({
    room: t.room.id,
    text: "On it.",
    flags: t.w.flags(),
    to: "U1SARA",
    replyTo: ask.ts,
  });
  expect(out.state).toBe("failed");
  expect(out.state === "failed" ? out.why : "").toContain("User OAuth Token");
  expect(t.api.sent).toEqual([]);
});
