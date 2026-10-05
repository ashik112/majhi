import { ALL_ASK, type Authority, type AutonomyMode } from "@majhi/shared";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../store/index.ts";
import { createChores } from "./chores.ts";
import type { CaptainPorts } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner, type RunnerDeps } from "./runner.ts";
import type { MapPorts } from "./upkeep-ports.ts";

function setup(opts: {
  stale: Awaited<ReturnType<MapPorts["stale"]>>;
  rest?: string | undefined;
  mode?: AutonomyMode;
  now?: Date;
}) {
  const now = opts.now ?? new Date("2026-10-06T12:00:00.000Z");
  const update = vi.fn(async () => ({ summary: "2 new lines to check, $0.20" }));
  const stale = vi.fn(async () => opts.stale);
  const ports = {
    map: { stale, update } satisfies MapPorts,
    laneRest: async () => opts.rest,
  } as unknown as CaptainPorts;
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const runner = new ChoreRunner({
    repo,
    now: () => now,
    workspace: async () => ({
      org: "acme",
      name: "Acme",
      mode: opts.mode ?? "on",
      authority: { ...ALL_ASK, upkeep: "decide" } as Authority,
      rules: undefined,
      tz: "UTC",
      day: "2026-10-06",
    }),
    stopped: () => false,
    tellOwner: () => {},
    laneTokens: () => 0,
    chores: createChores(ports, () => now) as RunnerDeps["chores"],
  });
  return { repo, runner, update, stale };
}

const lines = (repo: CaptainRepo) => repo.allActions().map((a) => `${a.outcome}: ${a.text}`);

describe("the map chore", () => {
  it("updates a stale map once and leaves one line", async () => {
    const t = setup({ stale: { stale: true, merges: 3, updatedAt: "2026-10-03T09:00:00.000Z" } });
    await t.runner.start("acme", "map", "daily");
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(lines(t.repo)).toEqual(["done: Updated the project map of Acme: 2 new lines to check, $0.20"]);
  });

  it("never updates twice in a day, however often it runs", async () => {
    const t = setup({ stale: { stale: true, merges: 3, updatedAt: "2026-10-03T09:00:00.000Z" } });
    await t.runner.start("acme", "map", "daily");
    await t.runner.start("acme", "map", "again");
    await t.runner.start("acme", "map", "and again");
    expect(t.update).toHaveBeenCalledTimes(1);
  });

  it("does nothing, and spends nothing, when no work merged since the last update", async () => {
    const t = setup({ stale: { stale: false, merges: 0, updatedAt: "2026-10-03T09:00:00.000Z" } });
    await t.runner.start("acme", "map", "daily");
    expect(t.stale).toHaveBeenCalled();
    expect(t.update).not.toHaveBeenCalled();
    expect(lines(t.repo)).toEqual([]);
  });

  it("leaves a map that was updated in the last 24 hours, even by the owner's own click", async () => {
    const t = setup({ stale: { stale: true, merges: 2, updatedAt: "2026-10-06T03:00:00.000Z" } });
    await t.runner.start("acme", "map", "daily");
    expect(t.update).not.toHaveBeenCalled();
  });

  it("does not run while the workspace's budget is used up, and says why once", async () => {
    const t = setup({
      stale: { stale: true, merges: 2 },
      rest: "Acme used its weekly budget",
    });
    await t.runner.start("acme", "map", "daily");
    expect(t.update).not.toHaveBeenCalled();
    expect(lines(t.repo)).toEqual(["skipped: Left the project map of Acme"]);
  });

  it("never runs when Auto-pilot is off", async () => {
    const t = setup({ stale: { stale: true, merges: 5 }, mode: "off" });
    const status = await t.runner.start("acme", "map", "daily");
    expect(status).toBeUndefined();
    expect(t.update).not.toHaveBeenCalled();
    expect(t.stale).not.toHaveBeenCalled();
  });
});
