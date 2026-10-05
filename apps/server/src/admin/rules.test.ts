import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

const asked = { ownerAsked: false, reason: "needed" };

describe("always-allow rules on approval cards", () => {
  it("saves the rule on approve, then runs the same command with no pending card, inside its scope only", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { admin } = h.majhi.services;
    const made = async () =>
      (await h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: false }))
        .body as { id: string };
    const [one, two, three] = [await made(), await made(), await made()];
    const builder = (task: string) => ({ task, agent: "acme-builder" });
    const cards = async (task: string) =>
      (await w.items(task)).filter(
        (i): i is Extract<RoomItem, { type: "approval" }> => i.type === "approval",
      );
    const create = (task: string, id: string) =>
      admin.call(builder(task), "majhi_orgs_create", { id, name: id, ...asked });

    // The first call waits. Approving with "this task" saves a task rule and runs it.
    await create(one.id, "globex");
    const [card] = await cards(one.id);
    expect(card).toMatchObject({ state: "pending" });
    const approved = await h.cmd("room.approve", {
      task: one.id,
      item: card?.id,
      decision: "approve",
      always: { scope: "task" },
    });
    expect(approved.status).toBe(200);
    const { policy } = (await h.cmd("settings.get")).body;
    expect(policy.rules).toEqual([{ agent: "acme-builder", command: "orgs.create", task: one.id }]);

    // The same command in that task now runs, and its card says which rule allowed it.
    const again = await create(one.id, "initech");
    expect(again.text).not.toContain("Waiting");
    expect((await cards(one.id)).at(-1)).toMatchObject({ state: "applied", rule: "task" });

    // Another task is not covered.
    await create(two.id, "umbrella");
    expect((await cards(two.id)).at(-1)).toMatchObject({ state: "pending" });

    // "Everywhere in the org" covers the other tasks in that org.
    const [pending] = await cards(two.id);
    await h.cmd("room.approve", {
      task: two.id,
      item: pending?.id,
      decision: "approve",
      always: { scope: "org" },
    });
    expect((await h.cmd("settings.get")).body.policy.rules).toContainEqual({
      agent: "acme-builder",
      command: "orgs.create",
      org: "acme",
    });
    await create(three.id, "hooli");
    expect((await cards(three.id)).at(-1)).toMatchObject({ state: "applied", rule: "org" });

    // Another agent is not covered, and removing the rules makes the command ask again.
    await admin.call({ task: three.id, agent: "boss" }, "majhi_orgs_create", {
      id: "pied",
      name: "p",
      ...asked,
    });
    expect((await cards(three.id)).at(-1)).toMatchObject({ agent: "boss", state: "pending" });
    for (const rule of (await h.cmd("settings.get")).body.policy.rules) {
      expect((await h.cmd("policy.removeRule", rule)).status).toBe(200);
    }
    await create(three.id, "wonka");
    expect((await cards(three.id)).at(-1)).toMatchObject({ state: "pending" });
  });

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
