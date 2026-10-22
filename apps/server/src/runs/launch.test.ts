import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { until } from "../testing/until.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("a run of a task", () => {
  it("makes its folder again when it is missing, with TASK.md, and starts", async () => {
    w = await bossWorld({ real: false });
    const services = w.h.majhi.services;
    const seen: { cwd: string; brief: boolean }[] = [];
    w.h.runtime.onSession = (_session, start) => {
      seen.push({ cwd: start.cwd, brief: existsSync(join(start.cwd, "TASK.md")) });
    };
    // A captain lane is a chat task: it has no worktree to bring its folder back.
    const lane = await services.lanes.ensure("acme");
    await rm(lane.folder, { recursive: true, force: true });

    const told = await services.lanes.tell("acme", "A client wrote.", "A client wrote");

    expect(told.sent).toBe(true);
    await until(() => seen.length === 1, "the session to start");
    expect(seen).toEqual([{ cwd: lane.folder, brief: true }]);
  });
});
