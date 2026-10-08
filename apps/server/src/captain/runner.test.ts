import { ALL_ASK, type Authority, type AutonomyMode, type CaptainChore } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { until } from "../testing/until.ts";
import { CaptainRepo } from "./repo.ts";
import { type ChoreRun, ChoreRunner, type RunnerDeps, type Workspace } from "./runner.ts";

/** The runner's guards one at a time, over a database in memory and chores the test writes. */

const DAY = "2026-10-03";

function setup(chore: (run: ChoreRun) => Promise<void>) {
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const state = {
    authority: {
      start: "decide",
      questions: "decide",
      approvals: "decide",
      upkeep: "decide",
      merge: "decide",
      push: "decide",
    } as Authority,
    rest: undefined as string | undefined,
    mode: "on" as AutonomyMode,
    stopped: false,
    tokens: 0,
    day: DAY,
    /** Minutes the clock moved since the run began. */
    minutes: 0,
  };
  const told: string[] = [];
  const ws = (): Workspace => ({
    org: "acme",
    name: "Acme",
    mode: state.mode,
    authority: state.authority,
    rules: undefined,
    tz: "UTC",
    day: state.day,
    ...(state.rest === undefined ? {} : { rest: state.rest }),
  });
  const chores = Object.fromEntries(
    (["ship", "cards", "questions", "memory", "projects", "triage", "cleanup"] as CaptainChore[]).map((c) => [
      c,
      chore,
    ]),
  ) as RunnerDeps["chores"];
  const runner = new ChoreRunner({
    repo,
    now: () => new Date(Date.parse(`${state.day}T12:00:00.000Z`) + state.minutes * 60_000),
    workspace: async () => ws(),
    stopped: () => state.stopped,
    tellOwner: (_org, text) => told.push(text),
    laneTokens: () => state.tokens,
    chores,
  });
  return { repo, state, told, runner };
}

describe("the chore runner", () => {
  it("reads the rules again right before an irreversible step, and leaves it when they changed", async () => {
    let did = 0;
    const t = setup(async (run) => {
      await run.act({
        key: "ship:ACM-1",
        text: "Shipped ACM-1",
        reason: "Runs it",
        task: "ACM-1",
        irreversible: true,
        recheck: async () => "a check fails now",
        do: async () => {
          did += 1;
          return {};
        },
      });
    });
    expect(await t.runner.start("acme", "ship", "test")).toBe("done");
    expect(did).toBe(0);
    expect(t.repo.allActions()).toEqual([expect.objectContaining({ outcome: "skipped" })]);
    // The owner moved the workspace to Ask me for everything a moment ago: the run stops before the step.
    const u = setup(async (run) => {
      u.state.authority = ALL_ASK;
      await run.act({ key: "k", text: "x", reason: "y", irreversible: true, do: async () => ({}) });
    });
    expect(await u.runner.start("acme", "ship", "test")).toBe("stopped");
    expect(u.repo.allActions().filter((a) => a.outcome === "done")).toEqual([]);
  });

  it("runs one run per chore and workspace; a trigger during it joins it for one more pass", async () => {
    let passes = 0;
    let release: () => void = () => {};
    const t = setup(async () => {
      passes += 1;
      if (passes === 1) await new Promise<void>((r) => (release = r));
    });
    const first = t.runner.start("acme", "cards", "a card arrived");
    await until(() => passes === 1);
    expect(await t.runner.start("acme", "cards", "another card")).toBeUndefined();
    expect(
      await t.runner.trigger({ org: "acme", chore: "cards", cause: "captain", why: "its own card" }),
    ).toBeUndefined();
    release();
    expect(await first).toBe("done");
    // Joined once (the captain's own trigger did not join), so two passes, and one run row.
    expect(passes).toBe(2);
    expect(t.repo.allRuns()).toHaveLength(1);
    expect(t.runner.selfDropped).toBe(1);
  });

  it("does one action when the same key is tried twice at the same moment", async () => {
    let did = 0;
    const t = setup(async (run) => {
      const step = () =>
        run.act({
          key: "ship:ACM-1:head",
          text: "Shipped",
          reason: "ready",
          do: async () => {
            await new Promise((r) => setTimeout(r, 2));
            did += 1;
            return {};
          },
        });
      const outcomes = await Promise.all([step(), step(), step()]);
      expect(outcomes.filter((o) => o === "done")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "repeat")).toHaveLength(2);
    });
    expect(await t.runner.start("acme", "ship", "go")).toBe("done");
    expect(did).toBe(1);
  });

  it("gives a failed step's key back, so the same state is tried again next run", async () => {
    let tries = 0;
    const t = setup(async (run) => {
      await run.act({
        key: "ship:ACM-1:head",
        text: "Shipped",
        reason: "ready",
        do: async () => {
          tries += 1;
          if (tries === 1) throw new Error("merge failed");
          return {};
        },
      });
    });
    expect(await t.runner.start("acme", "ship", "go")).toBe("done");
    expect(await t.runner.start("acme", "ship", "go")).toBe("done");
    expect(tries).toBe(2);
    expect(await t.runner.start("acme", "ship", "go")).toBe("done");
    expect(tries).toBe(2);
  });

  it("turns a chore off after two failures in a row and tells the owner once", async () => {
    const t = setup(async (run) => {
      for (const key of ["a", "b", "c"]) {
        await run.act({
          key,
          text: `Cleaned ${key}`,
          reason: "done",
          do: async () => {
            throw new Error("disk full");
          },
        });
      }
    });
    expect(await t.runner.start("acme", "cleanup", "daily")).toBe("failed");
    expect(t.repo.chore("acme", "cleanup").offAt).toBeDefined();
    expect(t.told).toHaveLength(1);
    // Off: the next day's run does not start.
    expect(await t.runner.start("acme", "cleanup", "daily")).toBeUndefined();
  });

  it("while Auto-pilot is off runs what reacts (ship, memory, cleanup) by its row and not the scheduled upkeep", async () => {
    const t = setup(async () => {});
    t.state.mode = "off";
    for (const chore of ["projects", "triage"] as const) {
      expect(await t.runner.start("acme", chore, "test")).toBeUndefined();
    }
    for (const chore of ["ship", "cards", "questions"] as const) {
      expect(await t.runner.start("acme", chore, "test")).toBe("done");
    }
    expect(await t.runner.start("acme", "memory", "test")).toBe("done");
    expect(await t.runner.start("acme", "cleanup", "test")).toBe("done");
    // Upkeep on "You decide": even those two stay put.
    t.state.authority = { ...ALL_ASK, merge: "decide" };
    expect(await t.runner.start("acme", "memory", "test")).toBeUndefined();
    t.state.mode = "on";
    t.state.authority = { ...ALL_ASK, upkeep: "decide" };
    expect(await t.runner.start("acme", "projects", "test")).toBe("done");
  });

  it("starts nothing while stopped, resting or in Only when I ask, and stops a run at the next step", async () => {
    let steps = 0;
    const t = setup(async (run) => {
      for (let i = 0; i < 5; i++) {
        if (i === 2) t.state.stopped = true;
        await run.act({
          key: `s${i}`,
          text: "step",
          reason: "r",
          do: async () => {
            steps += 1;
            return {};
          },
        });
      }
    });
    expect(await t.runner.start("acme", "ship", "go")).toBe("stopped");
    expect(steps).toBe(2);
    expect(await t.runner.start("acme", "ship", "go")).toBeUndefined();
    t.state.stopped = false;
    t.state.rest = "outside working hours (09:00 to 17:00)";
    expect(await t.runner.start("acme", "cards", "go")).toBeUndefined();
    t.state.rest = undefined;
    t.state.authority = ALL_ASK;
    expect(await t.runner.start("acme", "ship", "go")).toBeUndefined();
    expect(t.repo.allRuns()).toHaveLength(1);
  });

  it("ends a pass at 45 minutes with a line, and lets a slow ship run until then", async () => {
    let steps = 0;
    const t = setup(async (run) => {
      for (let i = 0; i < 4; i++) {
        t.state.minutes = i === 0 ? 0 : i === 1 ? 44 : 46;
        await run.act({
          key: `ship:${i}`,
          text: "Shipped",
          reason: "ready",
          do: async () => {
            steps += 1;
            return {};
          },
        });
      }
    });
    expect(await t.runner.start("acme", "ship", "slow suite")).toBe("capped");
    // The step at 44 minutes ran (a slow test suite no longer ends the run at 10); the one at 46 did not.
    expect(steps).toBe(2);
    expect(t.repo.allActions().some((a) => a.outcome === "skipped")).toBe(true);
  });

  it("stops a run that spent its tokens in the lane", async () => {
    const t = setup(async (run) => {
      t.state.tokens = 60_000;
      await run.act({ key: "q", text: "Asked the lane", reason: "unsure", do: async () => ({}) });
    });
    expect(await t.runner.start("acme", "questions", "a question")).toBe("capped");
    expect(t.repo.allRuns()[0]).toMatchObject({ status: "capped", tokens: 60_000 });
  });
});
