import { ALL_ASK, type Authority, type AutonomyMode, type CaptainCapAsk, type CaptainChore } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
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
  };
  const told: string[] = [];
  const asked: CaptainCapAsk[] = [];
  const caused: string[] = [];
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
    (
      ["ship", "cards", "questions", "memory", "projects", "triage", "cleanup", "stuck"] as CaptainChore[]
    ).map((c) => [c, chore]),
  ) as RunnerDeps["chores"];
  const runner = new ChoreRunner({
    repo,
    now: () => new Date(`${state.day}T12:00:00.000Z`),
    workspace: async () => ws(),
    stopped: () => state.stopped,
    tellOwner: (_org, text) => told.push(text),
    caused: (s) => caused.push(s),
    laneTokens: () => state.tokens,
    chores,
    capAsked: (ask) => asked.push(ask),
  });
  return { repo, state, told, caused, runner, asked };
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

  it("runs only memory and cleanup while Autonomous is off, and only where upkeep is the captain's", async () => {
    const t = setup(async () => {});
    t.state.mode = "off";
    for (const chore of ["ship", "cards", "questions", "projects", "triage", "stuck"] as const) {
      expect(await t.runner.start("acme", chore, "test")).toBeUndefined();
    }
    expect(await t.runner.start("acme", "memory", "test")).toBe("done");
    expect(await t.runner.start("acme", "cleanup", "test")).toBe("done");
    // Upkeep on "You decide": even those two stay put.
    t.state.authority = { ...ALL_ASK, merge: "decide" };
    expect(await t.runner.start("acme", "memory", "test")).toBeUndefined();
    t.state.mode = "on";
    t.state.authority = { ...ALL_ASK, upkeep: "decide" };
    expect(await t.runner.start("acme", "ship", "test")).toBe("done");
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
    t.state.authority = ALL_ASK;
    expect(await t.runner.start("acme", "ship", "go")).toBeUndefined();
    expect(t.repo.allRuns()).toHaveLength(1);
  });

  it("asks the owner once per chore, workspace and day when a daily cap is reached, and a raise holds for that day only", async () => {
    let n = 0;
    const t = setup(async (run) => {
      for (let i = 0; i < 8; i++) {
        n += 1;
        await run.act({ key: `ship:${n}`, text: "Shipped", reason: "checks pass", do: async () => ({}) });
      }
    });
    const ships = (day: string) => t.repo.actionsToday("acme", "ship", day);
    expect(await t.runner.start("acme", "ship", "ready for review")).toBe("capped");
    expect(ships(DAY)).toBe(5);
    // Another trigger the same day: still capped, and no second question.
    expect(await t.runner.start("acme", "ship", "ready for review")).toBe("capped");
    expect(t.asked).toEqual([
      {
        org: "acme",
        chore: "ship",
        day: DAY,
        kind: "actions",
        cap: 5,
        raiseTo: 10,
        text: "Acme: the captain shipped its 5 tasks for today. Raise the limit for today?",
        at: `${DAY}T12:00:00.000Z`,
      },
    ]);
    expect(t.repo.pendingCapAsks()).toHaveLength(1);

    // Raise: it ships on up to 10 today, and asks nothing more at the raised cap.
    expect(t.repo.answerCapAsk("acme", "ship", DAY, "raised", `${DAY}T12:01:00.000Z`)).toBe(true);
    expect(t.repo.answerCapAsk("acme", "ship", DAY, "left", `${DAY}T12:02:00.000Z`)).toBe(false);
    expect(await t.runner.start("acme", "ship", "ready for review")).toBe("capped");
    expect(ships(DAY)).toBe(10);
    expect(t.asked).toHaveLength(1);
    expect(t.repo.pendingCapAsks()).toEqual([]);

    // The next day the cap is 5 again, and it asks again. Leave it keeps the cap.
    const next = "2026-10-04";
    t.state.day = next;
    expect(await t.runner.start("acme", "ship", "ready for review")).toBe("capped");
    expect(ships(next)).toBe(5);
    expect(t.asked.map((a) => a.day)).toEqual([DAY, next]);
    expect(t.repo.answerCapAsk("acme", "ship", next, "left", `${next}T12:01:00.000Z`)).toBe(true);
    expect(await t.runner.start("acme", "ship", "ready for review")).toBe("capped");
    expect(ships(next)).toBe(5);
    expect(t.asked).toHaveLength(2);
  });

  it("asks when a chore's runs reach their daily cap", async () => {
    const t = setup(async () => {});
    for (let i = 0; i < 4; i++) expect(await t.runner.start("acme", "memory", "memories wait")).toBe("done");
    expect(await t.runner.start("acme", "memory", "memories wait")).toBeUndefined();
    expect(await t.runner.start("acme", "memory", "memories wait")).toBeUndefined();
    expect(t.asked).toEqual([
      expect.objectContaining({
        chore: "memory",
        kind: "runs",
        cap: 4,
        raiseTo: 8,
        text: "Acme: the captain did its 4 memory runs for today. Raise the limit for today?",
      }),
    ]);
    t.repo.answerCapAsk("acme", "memory", DAY, "raised", `${DAY}T12:01:00.000Z`);
    expect(await t.runner.start("acme", "memory", "memories wait")).toBe("done");
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
