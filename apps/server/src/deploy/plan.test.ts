import { afterEach, describe, expect, it } from "vitest";
import { DeployPlanner } from "./plan.ts";
import { C1, C2, environment, GH, push, type Rig, rig } from "./testing/rig.ts";

/** What the trail, the bar and the captain's chore read for a task that landed in the base branch. */

const task = (commit = C1) => ({
  id: "ACM-1",
  repos: [
    {
      project: "storefront",
      source: "/work/storefront",
      base: "main",
      branch: "task/acm-1",
      createdBranch: true,
      landed: { commit, into: "main", at: "2026-10-07T10:00:00.000Z" },
    },
  ],
});

const ship =
  (over: { rest?: string } = {}) =>
  async () => ({
    steps: {
      merge: "captain" as const,
      push: "captain" as const,
      deployStaging: "captain" as const,
      deployProduction: "owner" as const,
      tell: "owner" as const,
      rule: "abcd1234",
    },
    rest: over.rest,
    facts: { type: "bug" as const, changedLines: 38, projects: ["storefront"] },
  });

/** The ship rule of the owner's example: the captain deploys staging, production asks. */
const planner = (r: Rig, over: { rest?: string } = {}) =>
  new DeployPlanner({
    service: r.service,
    repo: r.store.deploys,
    ship: ship(over),
    environments: async () => r.project.environments,
  });

const planBoth = (r: Rig) =>
  r.service.plan(
    {
      task: "ACM-1",
      steps: [
        { project: "storefront", env: "staging", runs: GH },
        { project: "storefront", env: "production", runs: GH },
      ],
    },
    "captain",
  );

describe("the deploy steps of a task", () => {
  let r: Rig;
  afterEach(async () => {
    await r.service.idle();
    await r.hosts.close();
    r.store.close();
  });

  it("gives staging to the captain by its tier and keeps production behind it, then asks the owner once staging is live", async () => {
    r = await rig([environment("staging"), environment("production")]);
    push(r, C1);
    const { records } = await planBoth(r);
    const p = planner(r);
    expect((await p.stepsOf(task())).map((s) => [s.env, s.state, s.who])).toEqual([
      ["staging", "captain-next", "captain"],
      ["production", "waits-for-previous", "owner"],
    ]);
    await r.service.deploy({ record: records[0]?.id ?? 0 }, "captain");
    await r.service.idle();
    const after = await p.describe(task());
    expect(after.steps.map((s) => [s.env, s.state])).toEqual([
      ["staging", "live"],
      ["production", "waits-for-owner"],
    ]);
    expect(after.ask).toEqual({
      project: "storefront",
      env: "production",
      commit: C1,
      after: "staging",
      lines: 38,
    });
  });

  it("decides by the tier, not the name: a staging tier called qa is the captain's", async () => {
    r = await rig([environment("qa", { tier: "staging" })]);
    push(r, C1);
    await r.service.plan({ task: "ACM-1", steps: [{ project: "storefront", env: "qa", runs: GH }] }, "owner");
    expect((await planner(r).stepsOf(task())).map((s) => [s.env, s.who])).toEqual([["qa", "captain"]]);
  });

  it("shows a planned step as planned, with no commit, until the work landed", async () => {
    r = await rig([environment("staging")]);
    await r.service.plan(
      { task: "ACM-1", steps: [{ project: "storefront", env: "staging", runs: GH }] },
      "captain",
    );
    const unlanded = {
      id: "ACM-1",
      repos: [{ ...task().repos[0], landed: undefined }],
    } as unknown as ReturnType<typeof task>;
    const [step] = await planner(r).stepsOf(unlanded);
    expect(step).toMatchObject({ state: "planned", who: "captain" });
    expect(step?.commit).toBeUndefined();
  });

  it("blocks a deploy no rule may start: the commit was not merged by a task whose checks passed", async () => {
    r = await rig([environment("staging")]);
    push(r, C1);
    r.landed.clear();
    await r.service.plan(
      { task: "ACM-1", steps: [{ project: "storefront", env: "staging", runs: GH }] },
      "captain",
    );
    const [staging] = await planner(r).stepsOf(task());
    expect(staging).toMatchObject({ state: "blocked" });
    expect(staging?.why).toContain("has not been verified");
  });

  it("blocks it while the captain rests, and shows the reason", async () => {
    r = await rig([environment("staging")]);
    push(r, C1);
    await r.service.plan(
      { task: "ACM-1", steps: [{ project: "storefront", env: "staging", runs: GH }] },
      "captain",
    );
    const [staging] = await planner(r, { rest: "2026-12-24 is a freeze date" }).stepsOf(task());
    expect(staging).toMatchObject({
      state: "blocked",
      why: "The captain rests: 2026-12-24 is a freeze date",
    });
  });

  it("shows a held step as held and no longer asks", async () => {
    r = await rig([environment("staging"), environment("production")]);
    push(r, C1);
    await r.service.plan(
      {
        task: "ACM-1",
        steps: [
          { project: "storefront", env: "staging", runs: GH },
          { project: "storefront", env: "production", runs: GH, hold: "migration" },
        ],
      },
      "captain",
    );
    const out = await planner(r).describe(task());
    expect(out.steps.map((s) => [s.env, s.state])).toEqual([
      ["staging", "captain-next"],
      ["production", "held"],
    ]);
    expect(out.ask).toBeUndefined();
  });

  it("shows a failed deploy as failed, with what it said", async () => {
    r = await rig([environment("staging")]);
    push(r, C1);
    r.hosts.outcome.github = "failure";
    const { records } = await r.service.plan(
      { task: "ACM-1", steps: [{ project: "storefront", env: "staging", runs: GH }] },
      "captain",
    );
    await r.service.deploy({ record: records[0]?.id ?? 0 }, "captain");
    await r.service.idle();
    const [staging] = await planner(r).stepsOf(task());
    expect(staging?.state).toBe("failed");
    expect(staging?.why).toContain("failure");
  });

  it("reads nothing for a task with no plan", async () => {
    r = await rig([]);
    expect(await planner(r).stepsOf(task())).toEqual([]);
    expect(await planner(r).stepsOf({ id: "ACM-2", repos: [] })).toEqual([]);
  });
});
