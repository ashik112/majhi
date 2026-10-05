import type { PlaybooksList, RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { WAITING_TEXT } from "./service.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

const plain = { ownerAsked: false, reason: "the owner asked in chat" };
const cards = async () =>
  (await w.items()).filter((i): i is Extract<RoomItem, { type: "approval" }> => i.type === "approval");
const approve = async (command: string) => {
  const card = (await cards()).find((c) => c.command === command && c.state === "pending");
  const res = await w.h.cmd("room.approve", { task: w.chat.id, item: card?.id, decision: "approve" });
  expect(res.status, command).toBe(200);
  return res.body.item as { state: string; result?: string };
};
const orDo = async () =>
  ((await w.h.cmd("playbooks.list", { org: "acme" })).body as PlaybooksList).playbooks.find(
    (p) => p.playbook.id === "ops-uptime",
  )?.orDo;

describe("commands the captain does through the owner's approval", () => {
  it("refuses turning on a playbook's outcome rule before any card, and who is paged even after the owner's click", async () => {
    w = await bossWorld({ real: false });
    const caller = { task: w.chat.id, agent: "boss" };
    const { admin } = w.h.majhi.services;

    const limit = await admin.call(caller, "majhi_playbooks_update", {
      org: "acme",
      id: "ops-uptime",
      outcomes: { "ops-brief": true },
      ...plain,
    });
    expect(limit.isError).toBe(true);
    expect(await cards()).toEqual([]);

    const before = w.h.majhi.services.ops.watch.settings();
    expect(await admin.call(caller, "majhi_ops_settings", { escalateMin: 1, ...plain })).toEqual({
      text: WAITING_TEXT,
      isError: false,
    });
    const item = await approve("ops.settings");
    expect(item.state).toBe("failed");
    expect(w.h.majhi.services.ops.watch.settings()).toEqual(before);
  });
});

describe("full access for the captain", () => {
  it("runs the captain's change at once, but a permission change or a destructive one still waits", async () => {
    w = await bossWorld({ real: false });
    const { admin } = w.h.majhi.services;
    const on = await w.h.cmd("autonomy.configure", { orgs: { acme: { fullAccess: true } } });
    expect(on.status).toBe(200);
    // The captain's thread of Acme: full access is per workspace.
    const lane = await w.h.cmd("autonomy.guide", {
      text: "Tidy the uptime playbook.",
      keep: false,
      org: "acme",
    });
    const caller = { task: String(lane.body.chat), agent: "boss" };

    const playbook = await admin.call(caller, "majhi_playbooks_update", {
      org: "acme",
      id: "ops-uptime",
      orDo: "Tell the owner in one line",
      ...plain,
    });
    expect(playbook.text).not.toBe(WAITING_TEXT);
    expect(await orDo()).toBe("Tell the owner in one line");

    const allow = await admin.call(caller, "majhi_connections_allow", {
      id: "acme-box",
      allow: [],
      ...plain,
    });
    expect(allow).toEqual({ text: WAITING_TEXT, isError: false });
    const remove = await admin.call(caller, "majhi_tasks_remove", { id: "ACM-99", ...plain });
    expect(remove).toEqual({ text: WAITING_TEXT, isError: false });
  });

  it("only the owner turns it on", async () => {
    w = await bossWorld({ real: false });
    const agent = { actor: { kind: "agent", id: "boss" } };
    const res = await w.h.cmd("autonomy.configure", { orgs: { acme: { fullAccess: true } } }, agent);
    expect(res.status).not.toBe(200);
  });
});
