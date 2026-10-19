import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { PROPOSED_TEXT } from "./proposals.ts";

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

describe("the captain proposes what it may not do alone", () => {
  const PACE = { orgs: { acme: { tasksAtOnce: 3 } } };

  async function lane() {
    w = await bossWorld();
    const { h } = w;
    expect((await h.cmd("authority.set", { org: "acme", level: "routine" })).status).toBe(200);
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    const chat = await h.majhi.services.autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");
    const caller = { task: chat, agent: "boss" };
    const call = (tool: string, args: Record<string, unknown>) =>
      h.majhi.services.admin.call(caller, tool, { ...args, ownerAsked: false, reason: "test" });
    const pace = async () => (await h.cmd("settings.get")).body.autonomy.orgs.acme.tasksAtOnce;
    const proposals = async () =>
      (await w!.items(chat)).filter((i) => i.type === "approval") as Extract<
        RoomItem,
        { type: "approval" }
      >[];
    const decisions = async () =>
      (await h.cmd("decisions.list")).body.decisions as {
        id: string;
        options: { id: string; label: string }[];
        blocked?: string;
      }[];
    return { h, chat, call, pace, proposals, decisions };
  }

  it("becomes a card with a plain diff, and changes nothing", async () => {
    const { call, pace, proposals, decisions } = await lane();
    const before = await pace();
    const result = await call("majhi_autonomy_configure", PACE);
    expect(result).toEqual({ text: PROPOSED_TEXT, isError: false });
    expect(await pace()).toBe(before);
    const [card] = await proposals();
    expect(card).toMatchObject({ state: "pending", command: "autonomy.configure" });
    expect(card?.proposal?.changes).toEqual(["Tasks at once: none → 3"]);
    expect(JSON.parse(card?.input ?? "{}")).toEqual(PACE);
    // The same call again is the same card.
    await call("majhi_autonomy_configure", PACE);
    expect(await proposals()).toHaveLength(1);
    const mine = (await decisions()).find((d) => d.id.includes(card?.id ?? "?"));
    expect(mine?.options.map((o) => o.label)).toEqual(["Apply", "Reject"]);
  });
});
