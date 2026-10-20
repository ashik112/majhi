import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

/** A captain world with Acme at Routine and Autonomous on; the captain calls from Acme's lane. */
async function on() {
  w = await bossWorld({ real: false });
  const { h } = w;
  expect((await h.cmd("authority.set", { org: "acme", level: "routine" })).status).toBe(200);
  expect((await h.cmd("autonomy.start", { until: null })).status).toBe(200);
  const chat = await h.majhi.services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  const call = (tool: string, args: Record<string, unknown>) =>
    h.majhi.services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });
  const ownerTask = async (text: string, extra: Record<string, unknown> = {}): Promise<Task> => {
    const made = await h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: false, ...extra });
    expect(made.status).toBe(200);
    return made.body as Task;
  };
  return { h, call, ownerTask };
}

describe("what Autonomous may start", () => {
  it("never starts an idea, nothing in a workspace at Ask me, and nothing at all while it is off, and still reads", async () => {
    const t = await on();
    const fix = await t.ownerTask("Fix the typo on the login page");

    // An idea the owner kept for themselves, and one the captain filed for itself: both wait for the owner.
    const kept = await t.ownerTask("Rewrite the invoice export", { heldByOwner: true });
    expect(kept.idea).toBe("held-by-owner");
    const own = await t.call("majhi_tasks_create", {
      name: "Captain idea",
      text: "Tidy the api folder",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const ownId = (JSON.parse(own.text) as { id: string }).id;
    expect(t.h.majhi.services.store.tasks.get(ownId)?.idea).toBe("captain-made");
    for (const id of [kept.id, ownId]) {
      const refused = await t.call("majhi_tasks_start", { id });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("is an idea");
    }
    // The owner starts either one freely.
    expect((await t.h.cmd("tasks.start", { id: kept.id })).status).toBe(200);
    expect(t.h.majhi.services.store.tasks.get(kept.id)?.idea).toBeUndefined();

    // At Ask me the owner decides when work starts: the captain starts nothing there.
    expect((await t.h.cmd("authority.set", { org: "acme", level: "ask" })).status).toBe(200);
    const asked = await t.call("majhi_tasks_start", { id: fix.id });
    expect(asked.isError).toBe(true);
    expect(asked.text).toContain("you decide when work starts");
    expect((await t.h.cmd("authority.set", { org: "acme", level: "routine" })).status).toBe(200);

    // Off, it picks nothing from the backlog, and a read still answers.
    expect((await t.h.cmd("autonomy.stop")).status).toBe(200);
    const off = await t.call("majhi_tasks_start", { id: fix.id });
    expect(off.isError).toBe(true);
    expect(off.text).toContain("Autonomous is off");
    const list = await t.call("majhi_tasks_list", {});
    expect(list.isError).toBe(false);
    expect(list.text).toContain(fix.id);
  });
});
