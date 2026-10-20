import type { AutonomyStatus } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("Autonomous with an end time", () => {
  it("turns itself off at the time and pauses what it was working on, runs until the owner says otherwise when no time is given, and resumes the same tasks when turned on", async () => {
    let now = new Date("2026-10-20T22:00:00.000Z");
    w = await bossWorld({ real: false, runClock: () => now });
    const { h } = w;
    // Every turn of every agent lasts until the test lets it end.
    const waiting: (() => void)[] = [];
    const endTurns = () => {
      for (const end of waiting.splice(0)) end();
    };
    h.runtime.onSession = (session) => {
      session.script = async (turn) => {
        await new Promise<void>((end) => waiting.push(end));
        turn.emit({ type: "text", messageId: `m${session.prompts.length}`, text: "ok" });
        return "end_turn";
      };
    };
    const autonomy = h.majhi.services.autonomy;
    const status = async () => (await h.cmd("autonomy.status", {})).body as AutonomyStatus;
    expect((await h.cmd("authority.set", { org: "acme", level: "routine" })).status).toBe(200);

    const until = "2026-10-21T08:00:00.000Z";
    expect((await h.cmd("autonomy.start", { until })).status).toBe(200);
    expect(await status()).toMatchObject({ mode: "on", until });
    const chat = await autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");
    const made: string[] = [];
    for (const text of ["Fix the api", "Fix the web app"]) {
      // Tasks the owner made, which the captain takes from the backlog.
      const id = ((await h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: false })).body as { id: string }).id;
      const res = await h.majhi.services.admin.call({ task: chat, agent: "boss" }, "majhi_tasks_start", {
        id,
        reason: "next in the backlog",
      });
      expect(res.isError).toBe(false);
      made.push(id);
    }
    const task = (id: string) => h.majhi.services.store.tasks.get(id);
    await w.until(() => made.every((id) => task(id)?.status === "running"), "both tasks to run");
    // Each has more to do after its turn.
    for (const id of made) h.majhi.services.runs.notify(id, task(id)?.team[0] ?? "", "and then the next part");

    // A minute before 08:00 it is on; a minute after, it is turning off while the turns finish.
    now = new Date("2026-10-21T07:59:00.000Z");
    await autonomy.sweepNow();
    expect((await status()).mode).toBe("on");
    now = new Date("2026-10-21T08:01:00.000Z");
    await autonomy.sweepNow();
    expect((await status()).mode).toBe("stopping");

    // The turns end, and the tasks stop at that checkpoint instead of going on.
    endTurns();
    await w.until(async () => (await status()).mode === "off", "Autonomous to be off");
    expect(made.map((id) => task(id)?.status)).toEqual(["paused", "paused"]);
    expect((await status()).until).toBeUndefined();

    // Turned on with no end time it stays on, however long it is, and the same two tasks continue.
    expect((await h.cmd("autonomy.start", { until: null })).status).toBe(200);
    await w.until(() => made.every((id) => task(id)?.status === "running"), "the two tasks to resume");
    now = new Date("2026-12-31T00:00:00.000Z");
    await autonomy.sweepNow();
    expect(await status()).toMatchObject({ mode: "on" });
    endTurns();
  });
});
