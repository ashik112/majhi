import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { seedPerfVolume } from "../testing/perfSeed.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const BUDGET_MS = 250;

async function medianMs(run: () => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await run();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[2] ?? Number.POSITIVE_INFINITY;
}

describe("the Captain page's reads on a busy home", () => {
  it("answers autonomy.status and captain.status inside the budget at hundreds of tasks and thousands of rows", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    seedPerfVolume(h.majhi.services.store.raw);
    // The first call fills the config and agent caches; the budget is for the calls after it.
    await h.cmd("autonomy.status", { detail: true });
    await h.cmd("captain.status");
    const autonomy = await medianMs(() => h.cmd("autonomy.status", { detail: true }));
    const captain = await medianMs(() => h.cmd("captain.status"));
    expect({ autonomy: autonomy < BUDGET_MS, captain: captain < BUDGET_MS }).toEqual({
      autonomy: true,
      captain: true,
    });
  });

  it("lists an approval that waits for the owner and drops it once it is decided", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    seedPerfVolume(h.majhi.services.store.raw, { ...smallVolume, tasksPerOrg: 5 });
    const raw = h.majhi.services.store.raw;
    const waiting = async () =>
      ((await h.cmd("autonomy.status", { detail: true })).body.waiting as { task: string; item: string }[]).map(
        (x) => `${x.task}/${x.item}`,
      );
    // Every fourth seeded open task ends with a pending approval; ACM-4 is autonomous (not a multiple of 3), ACM-3 is not.
    raw.prepare("UPDATE tasks SET status = 'running' WHERE id IN ('ACM-4', 'ACM-3')").run();
    const before = await waiting();
    expect(before).toContain("ACM-4/i3");
    expect(before.some((x) => x.startsWith("ACM-3/"))).toBe(false);
    raw
      .prepare(
        "UPDATE room_items SET payload = json_set(payload, '$.state', 'applied') WHERE task = 'ACM-4' AND id = 'i3'",
      )
      .run();
    expect(await waiting()).not.toContain("ACM-4/i3");
  });
});

const smallVolume = {
  tasksPerOrg: 5,
  roomItemsPerTask: 3,
  turns: 10,
  decisions: 10,
  captainActions: 10,
  autonomyEvents: 10,
  findings: 10,
};
