import { afterEach, describe, expect, it } from "vitest";
import { DeployPlanner } from "./plan.ts";
import { C1, C2, push, type Rig, rig, workflow } from "./testing/rig.ts";

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

/** The ship rule of the owner's example: the captain deploys staging, production asks. */
const rules = (r: Rig) =>
  new DeployPlanner({
    service: r.service,
    repo: r.store.deploys,
    ship: async () => ({
      steps: {
        merge: "captain",
        push: "captain",
        deployStaging: "captain",
        deployProduction: "owner",
        tell: "owner",
        rule: "abcd1234",
      },
      rest: undefined,
      facts: { type: "bug", changedLines: 38, projects: ["storefront"] },
    }),
    targets: async () => r.project.targets,
  });

describe("the deploy steps of a task", () => {
  let r: Rig;
  afterEach(async () => {
    await r.service.idle();
    await r.hosts.close();
    r.store.close();
  });

  it("gives staging to the captain and keeps production behind it, then asks the owner once staging is live", async () => {
    r = await rig([workflow("staging"), workflow("production")]);
    push(r, C1);
    const planner = rules(r);
    expect((await planner.stepsOf(task())).map((s) => [s.env, s.state, s.who])).toEqual([
      ["staging", "captain-next", "captain"],
      ["production", "waits-for-previous", "owner"],
    ]);
    await r.service.deploy({ project: "storefront", env: "staging", task: "ACM-1" }, "captain");
    await r.service.idle();
    const after = await planner.describe(task());
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

  it("shows a held deploy as held and no longer asks", async () => {
    r = await rig([workflow("staging"), workflow("production")]);
    push(r, C1);
    await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
    await r.service.idle();
    await r.service.hold({ project: "storefront", env: "production", commit: C1, task: "ACM-1" });
    const out = await rules(r).describe(task());
    expect(out.steps.map((s) => [s.env, s.state])).toEqual([
      ["staging", "live"],
      ["production", "held"],
    ]);
    expect(out.ask).toBeUndefined();
  });

  it("blocks a deploy no rule may start: the commit was not merged by a task whose checks passed", async () => {
    r = await rig([workflow("staging")]);
    push(r, C1);
    r.landed.clear();
    const [staging] = await rules(r).stepsOf(task());
    expect(staging).toMatchObject({ state: "blocked" });
    expect(staging?.why).toContain("has not been verified");
  });

  it("blocks it while the captain rests, and shows the reason", async () => {
    r = await rig([workflow("staging")]);
    push(r, C1);
    const planner = new DeployPlanner({
      service: r.service,
      repo: r.store.deploys,
      ship: async () => ({
        steps: {
          merge: "captain",
          push: "captain",
          deployStaging: "captain",
          deployProduction: "owner",
          tell: "owner",
          rule: undefined,
        },
        rest: "2026-12-24 is a freeze date",
        facts: { projects: ["storefront"] },
      }),
      targets: async () => r.project.targets,
    });
    const [staging] = await planner.stepsOf(task());
    expect(staging).toMatchObject({
      state: "blocked",
      why: "The captain rests: 2026-12-24 is a freeze date",
    });
  });

  it("shows a failed deploy as failed, with what it said", async () => {
    r = await rig([workflow("staging")]);
    push(r, C1);
    r.hosts.outcome.github = "failure";
    await r.service.deploy({ project: "storefront", env: "staging", task: "ACM-1" }, "captain");
    await r.service.idle();
    const [staging] = await rules(r).stepsOf(task());
    expect(staging?.state).toBe("failed");
    expect(staging?.why).toContain("failure");
  });

  it("reads nothing for work that landed nowhere or a project with no target", async () => {
    r = await rig([]);
    push(r, C2);
    expect(await rules(r).stepsOf(task())).toEqual([]);
    expect(await rules(r).stepsOf({ id: "ACM-2", repos: [] })).toEqual([]);
  });
});
