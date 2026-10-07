import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

describe("always-allow rules on approval cards", () => {
  it("refuses always for a destructive command, leaves the card pending, and a plain approve runs it", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { admin } = h.majhi.services;
    const task = (
      await h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: false })
    ).body as { id: string };
    const draft = {
      frontmatter: { scope: "acme", role: "Builder", account: "claude-acme" },
      instructions: "Work.\n",
    };
    for (const id of ["acme-temp", "acme-temp2"])
      expect((await h.cmd("agents.create", { id, ...draft })).status).toBe(200);
    const caller = { task: task.id, agent: "acme-builder" };
    const remove = (id: string) =>
      admin.call(caller, "majhi_agents_remove", { id, ownerAsked: true, reason: "x" });
    const cards = async () => (await w.items(task.id)).filter((i) => i.type === "approval");

    await remove("acme-temp");
    const [card] = await cards();
    const refused = await h.cmd("room.approve", {
      task: task.id,
      item: card?.id,
      decision: "approve",
      always: { scope: "task" },
    });
    expect(refused.status).toBe(409);
    expect((await cards())[0]).toMatchObject({ state: "pending" });
    expect((await h.cmd("settings.get")).body.policy.rules).toEqual([]);

    // The old toggle is gone from policy.set, and a plain approve still works.
    expect((await h.cmd("policy.set", { allow_destructive_rules: true })).status).toBe(400);
    const ok = await h.cmd("room.approve", { task: task.id, item: card?.id, decision: "approve" });
    expect(ok.status).toBe(200);
  });
});
