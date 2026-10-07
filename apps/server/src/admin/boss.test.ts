import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

const say = (text: string) => w.h.cmd("room.send", { task: w.chat.id, text });
const idle = () => w.h.majhi.services.runs.idle(w.chat.id);
const cards = async () =>
  (await w.items()).filter((i): i is Extract<RoomItem, { type: "approval" }> => i.type === "approval");
const orgIds = async () =>
  (await w.h.cmd("orgs.list")).body.map((o: { id: string }) => o.id).filter((id: string) => id !== "private");
const ORG_CALL =
  'call: majhi_orgs_create {"id":"acme2","name":"Acme Two","ownerAsked":false,"reason":"the owner wants a second company"}';

describe("the captain through the fake adapter", () => {
  it("logs a rejection, and changes nothing", async () => {
    w = await bossWorld();
    expect((await say(ORG_CALL)).status).toBe(200);
    await idle();
    const [card] = await cards();
    const rejected = await w.h.cmd("room.approve", { task: w.chat.id, item: card?.id, decision: "reject" });
    expect(rejected.body.item).toMatchObject({ state: "rejected" });
    expect(await orgIds()).toEqual(["acme"]);
    expect(w.h.majhi.services.store.permissions.audit(w.chat.id)).toMatchObject([
      { kind: "orgs.create", decision: "deny", by: "owner" },
    ]);
  });

  it("revokes the token when the session ends", async () => {
    w = await bossWorld();
    const tokens = w.h.majhi.services.adminTokens;
    await say("hello");
    await idle();
    expect(tokens.size).toBe(1);
    await w.h.majhi.services.runs.stop(w.chat.id);
    expect(tokens.size).toBe(0);
  });
});
