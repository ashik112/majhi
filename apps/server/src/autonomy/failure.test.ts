import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("a task Autonomous works on that fails", () => {
  it("is tried again after the first failure, stops for the owner after the second, and only the owner takes it back", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const autonomy = h.majhi.services.autonomy;
    // The agent's session fails every time it is asked for anything.
    h.runtime.onSession = (session) => {
      session.script = async () => {
        throw new Error("the model fell over");
      };
    };
    expect((await h.cmd("authority.set", { org: "acme", level: "routine" })).status).toBe(200);
    expect((await h.cmd("autonomy.start", { until: null })).status).toBe(200);
    const chat = await autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");
    const call = (tool: string, args: Record<string, unknown>) =>
      h.majhi.services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });
    const made = await h.cmd("tasks.create", {
      text: "Fix the typo on the login page",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    const id = (made.body as Task).id;
    const task = () => h.majhi.services.store.tasks.get(id);

    expect((await call("majhi_tasks_start", { id })).isError).toBe(false);
    await w.until(() => autonomy.repo.failedRuns(id) === 1, "the first failure");
    expect(task()?.status).not.toBe("paused");

    // The second failure stops it, and the card says why.
    h.majhi.services.runs.notify(id, task()?.team[0] ?? "", "try again");
    await w.until(() => task()?.status === "paused", "the second failure to stop it");
    expect(task()).toMatchObject({ pausedReason: "autonomy", pausedBy: "autonomy-stop" });
    const room = await h.cmd("room.items", { task: id, limit: 100 });
    expect(JSON.stringify(room.body)).toContain("It failed twice.");
    // One row in Needs you, in the owner's own words.
    const waiting = (await h.cmd("decisions.list", {})).body as {
      decisions: { task?: string; kind: string; title: string }[];
    };
    expect(waiting.decisions.filter((d) => d.task === id).map((d) => [d.kind, d.title])).toEqual([
      ["paused", "Stopped by Autonomous: It failed twice."],
    ]);

    // The captain cannot take it back; the owner can.
    const again = await call("majhi_tasks_start", { id });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("Autonomous stopped");
    expect((await h.cmd("tasks.start", { id })).status).toBe(200);
    expect(task()?.status).not.toBe("paused");
  });
});
