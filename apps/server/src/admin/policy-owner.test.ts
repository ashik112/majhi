import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { WAITING_TEXT } from "./service.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

const plain = { ownerAsked: false, reason: "tidy up" };

describe("the approval policy", () => {
  it("runs a command by its own mode before its risk class", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    expect(
      (await h.cmd("policy.set", { change: "confirm", commands: { "orgs.update": "auto" } })).status,
    ).toBe(200);
    const task = (await h.cmd("tasks.create", { text: "fix api", start: false })).body as { id: string };
    const caller = { task: task.id, agent: "acme-builder" };
    const { admin } = h.majhi.services;

    // Neither is inside the task: their own mode (or their class, "change", which confirms) decides.
    const renamed = await admin.call(caller, "majhi_orgs_update", { id: "acme", name: "Acme Co", ...plain });
    expect(renamed.text).not.toBe(WAITING_TEXT);
    const typed = await admin.call(caller, "majhi_tasks_setType", { id: task.id, type: "bug", ...plain });
    expect(typed.text).toBe(WAITING_TEXT);

    const cards = (await w.items(task.id)).filter(
      (i): i is Extract<RoomItem, { type: "approval" }> => i.type === "approval",
    );
    expect(cards.map((c) => [c.command, c.state, c.alone])).toEqual(
      expect.arrayContaining([
        ["orgs.update", "applied", true],
        ["tasks.setType", "pending", undefined],
      ]),
    );
  });

  it("cannot be changed by an agent", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const before = (await h.cmd("settings.get")).body.policy;
    const task = (await h.cmd("tasks.create", { text: "fix api", start: false })).body as { id: string };
    const caller = { task: task.id, agent: "acme-builder" };
    const { admin } = h.majhi.services;

    const tool = await admin.call(caller, "majhi_policy_set", { change: "auto", ...plain });
    expect(tool).toEqual({ text: "Unknown tool: majhi_policy_set", isError: true });
    // settings.set has no policy: the field is dropped, whatever the mode lets run.
    await h.cmd("policy.set", { change: "auto" });
    await admin.call(caller, "majhi_settings_set", { policy: { destructive: "auto" }, ...plain });
    // An agent actor sent to the command itself is refused.
    const agentMeta = { actor: { kind: "agent", id: "acme-builder" } };
    const direct = await h.cmd("policy.set", { destructive: "auto" }, agentMeta);
    expect(direct.status).toBe(409);
    const remove = await h.cmd("policy.removeRule", { org: "acme", kind: "merge-main" }, agentMeta);
    expect(remove.status).toBe(409);

    const after = (await h.cmd("settings.get")).body.policy;
    expect(after).toEqual({ ...before, change: "auto" });
  });
});
