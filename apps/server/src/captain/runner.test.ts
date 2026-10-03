import type { CaptainChore, CaptainLevel } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { CaptainRepo } from "./repo.ts";
import { type ChoreRun, ChoreRunner, type RunnerDeps, type Workspace } from "./runner.ts";

/** The runner's guards one at a time, over a database in memory and chores the test writes. */

const DAY = "2026-10-03";

function setup(chore: (run: ChoreRun) => Promise<void>) {
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const state = {
    level: "runs" as CaptainLevel,
    rest: undefined as string | undefined,
    stopped: false,
    tokens: 0,
  };
  const told: string[] = [];
  const caused: string[] = [];
  const ws = (): Workspace => ({
    org: "acme",
    name: "Acme",
    level: state.level,
    rules: undefined,
    tz: "UTC",
    day: DAY,
    ...(state.rest === undefined ? {} : { rest: state.rest }),
  });
  const chores = Object.fromEntries(
    (
      ["ship", "cards", "questions", "memory", "projects", "triage", "cleanup", "stuck"] as CaptainChore[]
    ).map((c) => [c, chore]),
  ) as RunnerDeps["chores"];
  const runner = new ChoreRunner({
    repo,
    now: () => new Date(`${DAY}T12:00:00.000Z`),
    workspace: async () => ws(),
    stopped: () => state.stopped,
    tellOwner: (_org, text) => told.push(text),
    caused: (s) => caused.push(s),
    laneTokens: () => state.tokens,
    chores,
  });
  return { repo, state, told, caused, runner };
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
    expect(t.repo.allActions()).toEqual([
      expect.objectContaining({ outcome: "skipped", text: "Left ACM-1: a check fails now" }),
    ]);
    // The owner moved the workspace to Only when I ask a moment ago: the run stops before the step.
    const u = setup(async (run) => {
      u.state.level = "ask";
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
    await new Promise((r) => setTimeout(r, 5));
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

  it("does an action once whatever runs try it again, and stops at the run cap with a line", async () => {
    let did = 0;
    const t = setup(async (run) => {
      for (let i = 0; i < 30; i++) {
        await run.act({
          key: `card:${i % 25}`,
          text: `Approved card ${i}`,
          reason: "routine",
          do: async () => {
            did += 1;
            return {};
          },
        });
      }
    });
    expect(await t.runner.start("acme", "cards", "a burst")).toBe("capped");
    expect(did).toBe(20);
    // The next run does the five left; every repeat of a key done before changes nothing.
    expect(await t.runner.start("acme", "cards", "the rest")).toBe("done");
    expect(did).toBe(25);
    const ends = t.repo.allActions().filter((a) => a.text.startsWith("Approval cards stopped"));
    expect(ends[0]?.text).toBe("Approval cards stopped: reached its cap of 20 actions in one run");
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
    expect(t.told).toEqual([
      'Acme: the captain turned "Cleanup" off after 2 failures in a row, the last: disk full. Turn it on again on the Captain page.',
    ]);
    // Off: the next day's run does not start.
    expect(await t.runner.start("acme", "cleanup", "daily")).toBeUndefined();
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
    expect(await t.runner.start("acme", "ship", "go")).toBeUndefined();
    t.state.rest = undefined;
    t.state.level = "ask";
    expect(await t.runner.start("acme", "ship", "go")).toBeUndefined();
    expect(t.repo.allRuns()).toHaveLength(1);
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
