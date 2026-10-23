import type { Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { waitingDeployDecisions } from "../deploy/decisions.ts";
import { DeployPlanner } from "../deploy/plan.ts";
import { gitlabWorld, portsOf } from "../deploy/testing/gitlab-shop.ts";
import { C2, push as pushTo, type Rig } from "../deploy/testing/rig.ts";
import { CaseDeployer } from "./deploy.ts";
import { TaskDeploy } from "./task-deploy.ts";

/**
 * A finished task's deploy to three targets of a project whose deploy is GitLab jobs (the fake GitLab and hosts of the
 * case deploy's own test): the plan is one decision for the owner, and one click runs every target in order.
 */

const task = {
  id: "ACM-1",
  title: "Globex cannot print slips",
  repos: [
    {
      project: "storefront",
      branch: "fix/slips",
      landed: { commit: C2, into: "main", at: "2026-10-23T09:00:00.000Z" },
    },
  ],
} as unknown as Task;

/** The task merged on GitHub (base at C2); GitLab, which deploys, still has the first commit. Its plan is written. */
async function plannedWorld(): Promise<Rig> {
  const r = await gitlabWorld();
  pushTo(r, C2);
  // The captain names the target the task is about; majhi adds every other production target of the project.
  await r.service.plan({ task: "ACM-1", steps: [{ project: "storefront", env: "globex" }] }, "captain");
  return r;
}

function deployOf(r: Rig) {
  const running: Promise<void>[] = [];
  const notes: string[] = [];
  const deployer = new CaseDeployer({
    ...portsOf(r, ["backend/app/slips.py"]),
    // The task merged already: nothing lands, and nothing asks the hand-off checks again.
    land: async () => {
      throw new Error("a finished task lands nothing");
    },
    deploy: async (input, actor, hint) => {
      const out = await r.service.deploy(input, actor, undefined, hint);
      taskDeploy.recorded(out.record);
      return out;
    },
  });
  const taskDeploy: TaskDeploy = new TaskDeploy({
    deployer,
    tasks: { get: (id) => (id === task.id ? task : undefined) },
    hasRecipe: async (project, env) =>
      r.project.environments.find((e) => e.env === env && project === r.project.id)?.recipe !== undefined,
    repo: r.store.deploys,
    note: (_task, _key, _level, text) => void notes.push(text),
    background: (run) => void running.push(run()),
  });
  return { taskDeploy, notes, settled: () => Promise.all(running) };
}

const played = (r: Rig) => r.hosts.played.map((p) => [p.job, p.variables] as const);
const sent = (target: string, version: string) => ({
  TARGET: target,
  CONFIRM_TARGET: target,
  COMPONENTS: "backend",
  VERSION: version,
});

describe("a finished task's deploy", () => {
  it("is one decision for the owner, and one click pushes the commit, then builds, deploys and checks each target in order", async () => {
    const r = await plannedWorld();
    try {
      // One card for the whole task, naming every target, though the commit is not on the host that deploys yet.
      const planner = new DeployPlanner({
        service: r.service,
        repo: r.store.deploys,
        ship: async () =>
          ({
            steps: { deployStaging: "owner", deployProduction: "owner" },
            rest: undefined,
            facts: {},
          }) as never,
        environments: async () => r.project.environments,
      });
      const steps = (await planner.stepsOf(task)).map(({ task: _task, ...step }) => step);
      expect(steps.map((s) => [s.env, s.state])).toEqual([
        ["globex", "waits-for-owner"],
        ["acme", "waits-for-previous"],
        ["initech", "waits-for-previous"],
      ]);
      const cards = waitingDeployDecisions([{ task: task.id, steps }], () => ({
        title: task.title,
        updatedAt: "2026-10-23T09:00:00.000Z",
      }));
      expect(cards.map((c) => [c.title, c.options.map((o) => o.label)])).toEqual([
        ["Deploy to production: Globex cannot print slips", ["Deploy"]],
      ]);
      expect(cards[0]?.sentence).toContain("storefront globex, storefront acme and storefront initech");
      expect(r.hosts.played).toEqual([]);
      expect(r.published).toEqual([]);

      // The click: nothing more is asked of the owner.
      const { taskDeploy, notes, settled } = deployOf(r);
      const first = await taskDeploy.start(task.id, "owner");
      expect(first?.record).toMatchObject({ env: "globex", task: "ACM-1" });
      await settled();

      expect(r.store.deploys.ofTask("ACM-1").map((d) => [d.env, d.state, d.by])).toEqual([
        ["globex", "live", "owner"],
        ["acme", "live", "owner"],
        ["initech", "live", "owner"],
      ]);
      // GitLab was sent the merged commit once, by the owner's click, before anything was played.
      expect(r.published).toEqual([{ remote: "gitlab", commit: C2, actor: "owner" }]);
      expect(played(r)).toEqual([
        ["image:build:globex", { VERSION: "globex-2.0.4" }],
        ["app:deploy:globex", sent("globex", "globex-2.0.4")],
        ["app:status:globex", { TARGET: "globex" }],
        ["image:build:production", { VERSION: "1.4.8" }],
        ["app:deploy:acme", sent("acme", "1.4.8")],
        ["app:status:acme", { TARGET: "acme" }],
        ["app:deploy:initech", sent("initech", "1.4.8")],
        ["app:status:initech", { TARGET: "initech" }],
      ]);
      expect(notes.filter((n) => n.endsWith("is live at 2222222."))).toHaveLength(3);
    } finally {
      await r.service.idle();
      await r.hosts.close();
      r.store.close();
    }
  });

  it("puts the target that failed back and does not start the next", async () => {
    const r = await plannedWorld();
    try {
      r.hosts.jobOutcomes.set("app:deploy:acme", ["failed"]);
      const { taskDeploy, notes, settled } = deployOf(r);
      await taskDeploy.start(task.id, "owner");
      await settled();

      expect(r.store.deploys.ofTask("ACM-1").map((d) => [d.env, d.state])).toEqual([
        ["globex", "live"],
        ["acme", "rolled-back"],
        // Never started: its row stays as it was planned.
        ["initech", "planned"],
      ]);
      expect(played(r)).toEqual([
        ["image:build:globex", { VERSION: "globex-2.0.4" }],
        ["app:deploy:globex", sent("globex", "globex-2.0.4")],
        ["app:status:globex", { TARGET: "globex" }],
        ["image:build:production", { VERSION: "1.4.8" }],
        ["app:deploy:acme", sent("acme", "1.4.8")],
        ["app:deploy:acme", sent("acme", "1.4.7")],
        ["app:status:acme", { TARGET: "acme" }],
      ]);
      expect(r.incidents.map((i) => i.record.env)).toEqual(["acme"]);
      expect(notes.some((n) => n.includes("acme did not go live"))).toBe(true);
    } finally {
      await r.service.idle();
      await r.hosts.close();
      r.store.close();
    }
  });
});
