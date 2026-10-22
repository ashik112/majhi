import { describe, expect, it } from "vitest";
import { C1, C2, environment, GH, push as pushTo, rig } from "../deploy/testing/rig.ts";
import { CaseDeployer, type CaseDeployPorts } from "./deploy.ts";
import { closingLines, newCase, rollbackTarget, withDeploy, withRollback } from "./record.ts";

/**
 * The captain's deploy of a case's fix (docs/briefs/instructions.md). The deploy service is the real one, on the
 * deploy rig with its fake GitHub: what a case adds is only which deploy it may repeat and when.
 */
describe("a case deploy", () => {
  it("refuses without passing checks or a known deploy path, notes the version it replaces, and rolls back once", async () => {
    const r = await rig([environment("production")]);
    try {
      const checks = { pass: true };
      const landed: string[] = [];
      const ports: CaseDeployPorts = {
        environments: async () => r.project.environments,
        latestLive: (project, env) => r.store.deploys.latestLive(project, env),
        repeatable: (runs) => r.service.repeatable(runs),
        onHost: (project) => r.service.onHost(project),
        checks: async () => (checks.pass ? { ok: true } : { ok: false, why: "the tests of storefront fail" }),
        land: async (_task, project, pushed) => {
          landed.push(`${project} pushed=${pushed}`);
          pushTo(r, C2);
        },
        deploy: (input, actor) => r.service.deploy(input, actor),
        rollback: (id, actor) => r.service.rollback(id, actor),
        record: (id) => r.store.deploys.get(id),
        now: () => new Date(),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        pollMs: 1,
        waitMs: 60_000,
      };
      const deployer = new CaseDeployer(ports);
      const fix = { task: "ACM-1", project: "storefront", branch: "fix/worker" };

      // The project never went live through a run majhi can repeat: no deploy path, and nothing moved.
      expect(await deployer.prepare(fix)).toMatchObject({
        ok: false,
        why: expect.stringContaining("no deploy majhi can repeat"),
      });

      // The owner deployed it before. That deploy is the path the captain repeats.
      pushTo(r, C1);
      await r.service.deploy({ project: "storefront", env: "production", runs: GH }, "owner");
      await r.service.idle();

      // Checks that did not pass stop it before the branch lands.
      checks.pass = false;
      expect(await deployer.prepare(fix)).toMatchObject({
        ok: false,
        why: expect.stringContaining("did not pass: the tests of storefront fail"),
      });
      expect(landed).toEqual([]);

      // With the checks green it lands, deploys through the same runs and goes live.
      checks.pass = true;
      const path = await deployer.prepare(fix);
      if (!path.ok) throw new Error(path.why);
      expect(path.previous).toBe(C1);
      const record = await deployer.run({
        task: fix.task,
        project: fix.project,
        env: path.env.env,
        runs: path.runs,
        landed: false,
      });
      expect(landed).toEqual(["storefront pushed=true"]);
      // The deploy knows the version it replaced, and the case says it for the owner.
      expect(record).toMatchObject({ state: "live", commit: C2, previous: C1, by: "captain" });
      const at = new Date().toISOString();
      let kase = withDeploy(
        newCase({ room: "r1", client: "Ana", symptom: "no slips", at, day: "2026-10-22" }),
        {
          at,
          project: fix.project,
          env: path.env.env,
          branch: fix.branch,
          previous: path.previous,
          commit: record.commit,
          record: record.id,
          state: "live",
        },
      );
      expect(closingLines(kase)).toEqual([
        "Deployed fix/worker to storefront production (replaced 1111111).",
      ]);

      // The rollback puts the replaced version back, and only once.
      expect(rollbackTarget(kase)?.record).toBe(record.id);
      const back = await deployer.rollback(record.id);
      expect(back).toMatchObject({ state: "rolled-back", rollback: { ok: true, commit: C1 } });
      kase = withRollback(kase, { at, record: record.id, to: C1, ok: true });
      expect(rollbackTarget(kase)).toBeUndefined();
      expect(closingLines(kase).at(-1)).toBe("Rolled back to 1111111.");
      expect((await ports.rollback(record.id, "captain")).repeat).toBe(true);
    } finally {
      await r.service.idle();
      await r.hosts.close();
      r.store.close();
    }
  });
});
