import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

/** The startup move from the pick rule's workspace list to the choice per workspace (5.18). */

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("moving the old workspace list to the choice per workspace", () => {
  it("sets each listed workspace to Runs it in one config commit by majhi, keeps the rest, and does it once", async () => {
    w = await taskWorld();
    const { config, captain } = w.h.majhi.services;
    await config.setSettings(
      {
        autonomy: {
          pick: { size: "medium", orgs: ["acme"] },
          orgs: { acme: { cap: { cost: 3 }, push: false, merge: false } },
        },
      },
      { command: "settings.set", meta: { actor: { kind: "owner" } }, summary: "an old pick rule" },
    );
    expect(await captain.migratePick()).toBe(true);
    const autonomy = (await config.settings()).autonomy;
    expect(autonomy.pick).toEqual({ size: "medium" });
    expect(autonomy.orgs).toEqual({ acme: { level: "runs", cap: { cost: 3 }, push: false, merge: false } });
    const [last] = await config.historyEntries(1);
    expect(last).toMatchObject({ summary: "set Acme to Runs it, from autonomous mode's workspace list" });
    // Private was not listed: it keeps its default.
    const status = (await w.h.cmd("captain.status")).body as { orgs: { org: string; level: string }[] };
    expect(status.orgs.map((o) => [o.org, o.level])).toEqual([
      ["private", "tidy"],
      ["acme", "runs"],
    ]);
    // A second start finds nothing to move and makes no commit.
    expect(await captain.migratePick()).toBe(false);
    expect((await config.historyEntries(1))[0]?.commit).toBe(last?.commit);
  });
});
