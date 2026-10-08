import { afterEach, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { captainScript } from "../testing/captainScript.ts";
import { CONN, envelope } from "./testing/world.ts";

/**
 * A client reports a problem and no watch is firing. The captain (a scripted fake, so no tokens) checks, opens an
 * incident and tells the client what it checked. It asks the client nothing first.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

it("a problem report with no watch firing leads the captain to open an incident and reply with what it checked", async () => {
  w = await bossWorld();
  const { h } = w;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  const lane = await h.majhi.services.autonomy.laneChat("acme");
  if (lane === undefined) throw new Error("no lane for Acme");
  const { chatParts } = h.majhi.services;
  await chatParts.ingest.deliver(CONN, envelope({ message: "1", text: "hello" }));
  const found = chatParts.rooms.find("telegram", CONN.account, "-100");
  if (found === undefined) throw new Error("no chat room");
  await chatParts.rooms.link(found.id, "acme");
  const room = found.id;

  const script = await captainScript(
    w,
    [
      {
        when: /Client chat/,
        steps: [
          { tool: "majhi_chat_history", args: { room } },
          { tool: "majhi_watch_overview", args: { org: "acme" } },
          {
            tool: "majhi_chat_openIncident",
            args: {
              room,
              found: "No watch is firing and the last deploy is green, but the client sees the page fail.",
            },
          },
          {
            tool: "majhi_chat_reply",
            args: {
              room,
              text: "I checked our watches and the last deploy: both look fine from here. I opened an incident and we are on it.",
              promisedTime: false,
              money: false,
              security: false,
              severalClients: false,
              to: "u1",
              replyTo: "2",
            },
          },
        ],
      },
    ],
    { task: lane },
  );
  await chatParts.ingest.deliver(
    CONN,
    envelope({ message: "2", text: "The orders page is not loading for us" }),
  );
  const calls = await script.calls(4);

  expect(calls.map((c) => c.tool)).toEqual([
    "majhi_chat_history",
    "majhi_watch_overview",
    "majhi_chat_openIncident",
    "majhi_chat_reply",
  ]);
  expect(calls.every((c) => c.isError !== true)).toBe(true);
  const incident = h.majhi.services.store.tasks.list(false).find((t) => t.typing?.type === "incident");
  expect(incident?.org).toBe("acme");
  const items = h.majhi.services.store.room.page(room, 30).items;
  const reply = items.find((i) => i.type === "client-reply");
  expect(reply).toMatchObject({ text: expect.stringContaining("I checked our watches") });
  const message = items.find((i) => i.type === "client" && i.external.message === "2");
  expect(message).toMatchObject({ outcome: { task: incident?.id } });
}, 60_000);
