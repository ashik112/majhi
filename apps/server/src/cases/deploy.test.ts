import type { DeployEnvironment } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { discoverEnvironments } from "../deploy/discover.ts";
import {
  ACME_SHOP_MONO_FILES,
  ACME_SHOP_MONO_FOLDERS,
  acmeShopCi,
  memoryCi,
} from "../deploy/testing/acme-shop.ts";
import { gitlabWorld, portsOf, reads, type Target } from "../deploy/testing/gitlab-shop.ts";
import { C1, C2, environment, GH, push as pushTo, type Rig, rig } from "../deploy/testing/rig.ts";
import { CaseDeployer, type CaseDeployPorts } from "./deploy.ts";
import {
  closingLines,
  newCase,
  rollbackTarget,
  rollbackTargets,
  withDeploy,
  withRollback,
} from "./record.ts";

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
        discover: async () => [],
        remember: async () => undefined,
        current: (project, env, opts) => r.service.current(project, env, opts),
        hostChoices: (project, env, connection) => r.service.hostChoices(project, env, connection),
        nextVersion: (project, env) => r.service.nextVersion(project, env),
        changedPaths: async () => undefined,
        latestLive: (project, env) => r.store.deploys.latestLive(project, env),
        repeatable: (runs) => r.service.repeatable(runs),
        onHost: (project) => r.service.onHost(project),
        checks: async () => (checks.pass ? { ok: true } : { ok: false, why: "the tests of storefront fail" }),
        land: async (_task, project, pushed) => {
          landed.push(`${project} pushed=${pushed}`);
          pushTo(r, C2);
        },
        deploy: (input, actor, hint) => r.service.deploy(input, actor, undefined, hint),
        rollback: (id, actor) => r.service.rollback(id, actor),
        record: (id) => r.store.deploys.get(id),
        rollingBack: (id) => r.service.rollingBackIds().includes(id),
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

/** The environments of the sample `acme-shop`, as discovery reads them from its CI files. */
async function shop(): Promise<DeployEnvironment[]> {
  const found = await discoverEnvironments({
    files: await acmeShopCi(),
    base: "main",
    provider: "github",
    remote: "origin",
    folders: ["backend", "frontend"],
  });
  return found.environments.map((e) => ({ ...e, check: `https://${e.env}.acme.example/health` }));
}

const fix = { task: "ACM-1", project: "storefront", branch: "fix/slips" };

/** The workflow dispatches the fake GitHub saw, in order: which workflow, and what it was sent. */
const dispatches = (r: Rig) =>
  r.hosts.calls
    .filter((c) => c.method === "POST")
    .map((c) => [c.path.split("/workflows/")[1], c.body] as const);

/** The commands run on the workspace's hosts, each once: which host, and what. */
const askedHosts = (r: Rig) => [...new Set(r.remote.map((c) => `${c.alias} ${c.command}`))];

describe("a case deploy through the recipe of the project's CI", () => {
  /** What the sample project's workflows say in their run titles, and the images its containers run. */
  function titles(r: Rig) {
    r.hosts.runNames.set(
      "build-image.yml",
      (i) => `Build backend ${i.version || "next version"} from ${i.source_ref || "main"}`,
    );
    r.hosts.runNames.set("release.yml", (i) => `Deploy ${i.target} ${i.components} from ${i.source_ref}`);
  }
  const slug = "acme/storefront";

  it("picks the next version, reads what runs from the host, builds, releases the built tag, and goes back once", async () => {
    const r = await rig(await shop());
    try {
      titles(r);
      // The registry has 1.4.2 and 1.4.7 (the build's titles); acme's containers run 1.4.7, with the frontend beside them.
      r.hosts.seedRun({ slug, workflow: "build-image.yml", sha: C1, inputs: { version: "1.4.2" } });
      r.hosts.seedRun({
        slug,
        workflow: "build-image.yml",
        sha: C1,
        inputs: { version: "1.4.7", source_ref: C1 },
      });
      r.hosts.seedRun({ slug, workflow: "build-image.yml", sha: C1, inputs: {} });
      r.remoteRun.output = [
        "registry.acme.example/acme-shop/backend:1.4.7",
        "registry.acme.example/acme-shop/frontend:3.1.0",
        "postgres:16",
      ].join("\n");
      pushTo(r, C1);
      // The first build is refused, because that version exists in the registry: majhi takes the next patch once more.
      r.hosts.outcomeQueue.push("failure");
      const landed: string[] = [];
      const ports = portsOf(r, ["backend/app/slips.py"], landed);
      const deployer = new CaseDeployer(ports);

      const path = await deployer.prepare({ ...fix, env: "acme" });
      if (!path.ok) throw new Error(path.why);
      // What acme runs is read from the host with a read command, and its commit from the build that made it.
      expect(askedHosts(r)).toEqual(["deploy@203.0.113.7 docker ps --format '{{.Image}}'"]);
      expect(path.replaces).toEqual({ version: "1.4.7", commit: C1, from: "host" });
      expect(path.notes).toContain("Deploys acme the way .github/workflows/release.yml:6 says.");
      expect(path.notes).toContain("Components: backend, because only backend files changed.");
      expect(path.notes).toContain("Build version: 1.4.8, the next patch after 1.4.7.");
      expect(dispatches(r)).toEqual([]);

      const record = await deployer.run({
        ...fix,
        env: "acme",
        runs: path.runs,
        replaces: path.replaces,
        landed: false,
      });
      expect(landed).toEqual(["storefront"]);
      expect(record).toMatchObject({
        state: "live",
        commit: C2,
        version: "1.4.9",
        replaces: { version: "1.4.7", commit: C1 },
      });
      // What runs now was read before the first dispatch; then the build (refused once), then the release with its tag.
      const calls = r.hosts.calls.map((c) => `${c.method} ${c.path.split("/workflows/")[1] ?? ""}`);
      expect(calls.findIndex((c) => c.startsWith("GET build-image.yml/runs"))).toBeLessThan(
        calls.findIndex((c) => c.startsWith("POST")),
      );
      expect(dispatches(r)).toEqual([
        ["build-image.yml/dispatches", { ref: "main", inputs: { version: "1.4.8", source_ref: C2 } }],
        ["build-image.yml/dispatches", { ref: "main", inputs: { version: "1.4.9", source_ref: C2 } }],
        [
          "release.yml/dispatches",
          {
            ref: "main",
            inputs: { target: "acme", components: "backend", source_ref: C2, backend_version: "1.4.9" },
          },
        ],
      ]);

      // The rollback workflow goes out once, with the version and commit recorded before the deploy.
      const back = await deployer.rollback(record.id);
      expect(back).toMatchObject({ state: "rolled-back", rollback: { ok: true, commit: C1 } });
      expect(dispatches(r).slice(3)).toEqual([
        [
          "rollback.yml/dispatches",
          {
            ref: "main",
            inputs: { target: "acme", components: "backend", backend_version: "1.4.7", source_ref: C1 },
          },
        ],
      ]);
      expect((await ports.rollback(record.id, "captain")).repeat).toBe(true);
      expect(dispatches(r)).toHaveLength(4);
    } finally {
      await r.service.idle();
      await r.hosts.close();
      r.store.close();
    }
  });

  it("asks once, and starts nothing, when what an environment runs cannot be read or several hosts could be it", async () => {
    const r = await rig(await shop());
    try {
      titles(r);
      r.hosts.seedRun({
        slug,
        workflow: "build-image.yml",
        sha: C1,
        inputs: { version: "1.4.7", source_ref: C1 },
      });
      r.remoteRun.output = "registry.acme.example/acme-shop/backend:1.4.7";
      pushTo(r, C1);
      const deployer = new CaseDeployer(portsOf(r, ["backend/app/slips.py"]));

      // No connection of the workspace is named for initech: one question, and nothing was dispatched.
      const asked = await deployer.prepare({ ...fix, env: "initech" });
      expect(asked).toMatchObject({ ok: false, ask: [{ id: "previous-version", options: [] }] });
      expect(dispatches(r)).toEqual([]);

      // With the owner's version it goes: the commit is read from the build that made it, and nothing asks again.
      const answered = await deployer.prepare({
        ...fix,
        env: "initech",
        answers: { "previous-version": "1.4.7" },
      });
      expect(answered).toMatchObject({
        ok: true,
        previous: "1.4.7",
        replaces: { version: "1.4.7", commit: C1, from: "owner" },
      });

      // Two hosts could be acme's: one card asks which, and nothing was run on either.
      r.sshHosts.push({ id: "acme-eu", name: "Acme EU", alias: "deploy@203.0.113.9" });
      r.remote.length = 0;
      const which = await deployer.prepare({ ...fix, env: "acme" });
      expect(which).toMatchObject({
        ok: false,
        ask: [{ id: "connection", options: ["acme-host", "acme-eu"] }],
      });
      expect(r.remote).toEqual([]);
      // The owner's pick is read from that host, and kept on the recipe for the next deploy.
      const picked = await deployer.prepare({ ...fix, env: "acme", answers: { connection: "acme-eu" } });
      expect(picked).toMatchObject({
        ok: true,
        replaces: { version: "1.4.7", from: "host" },
        remember: { connection: "acme-eu" },
      });
      expect(askedHosts(r)).toEqual(["deploy@203.0.113.9 docker ps --format '{{.Image}}'"]);
    } finally {
      await r.service.idle();
      await r.hosts.close();
      r.store.close();
    }
  });
});

describe("a case deploy to every production target through GitLab", () => {
  /**
   * What the case saw: each environment as it started (what it replaces, how many jobs were played already, and
   * whether its host was read again after the plan) and how it ended.
   */
  function watch(r: Rig, events: string[]) {
    const afterPlan = { acme: reads(r, "acme"), globex: reads(r, "globex"), initech: reads(r, "initech") };
    return {
      started: (path: { env: { env: string }; previous: string }) =>
        void events.push(
          `${path.env.env} starts, replacing ${path.previous}, after ${r.hosts.played.length} jobs, host read ${
            reads(r, path.env.env) > afterPlan[path.env.env as Target] ? "again" : "once"
          }`,
        ),
      ended: (path: { env: { env: string } }, record: { state: string }) =>
        void events.push(`${path.env.env} ${record.state}`),
      threw: () => undefined,
    };
  }

  const played = (r: Rig) => r.hosts.played.map((p) => [p.job, p.variables] as const);
  const sent = (target: string, version: string) => ({
    TARGET: target,
    CONFIRM_TARGET: target,
    COMPONENTS: "backend",
    VERSION: version,
  });

  it("pushes the commit to GitLab first, then builds and deploys each target in order, each with the version it replaces recorded before it", async () => {
    const r = await gitlabWorld();
    try {
      const landed: string[] = [];
      const deployer = new CaseDeployer(portsOf(r, ["backend/app/slips.py"], landed));
      // The case is about globex: it goes first, then the others in the project's order.
      const plan = await deployer.plan({ ...fix, about: ["Globex cannot print slips"] });
      if (!plan.ok) throw new Error(plan.why);
      expect(plan.envs).toEqual(["globex", "acme", "initech"]);
      expect(r.hosts.played).toEqual([]);
      expect(r.published).toEqual([]);

      const events: string[] = [];
      const done = await deployer.deployAll(
        { ...fix, about: ["Globex cannot print slips"], landed: false },
        plan,
        watch(r, events),
      );
      expect(done.blocked).toBeUndefined();
      expect(done.targets.map((t) => [t.path.env.env, t.record.state, t.record.version])).toEqual([
        ["globex", "live", "globex-2.0.4"],
        ["acme", "live", "1.4.8"],
        ["initech", "live", "1.4.8"],
      ]);

      // The fix landed, and GitLab was sent the merged main once: a fast-forward by a push, never forced.
      expect(landed).toEqual(["storefront"]);
      expect(r.published).toEqual([{ remote: "gitlab", commit: C2, actor: "captain" }]);

      // Each target: the build of its registry (initech's image is acme's, built just before), the deploy with the target
      // confirmed and the version, then the target's status. Every job is one of the commit's pipeline.
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
      expect(new Set(r.hosts.played.map((p) => p.pipeline)).size).toBe(1);

      // What a target ran was read from its containers and noted before its own step: the later hosts are read again
      // after the targets before them were played.
      expect(events).toEqual([
        "globex starts, replacing globex-2.0.3, after 0 jobs, host read once",
        "globex live",
        "acme starts, replacing 1.4.7, after 3 jobs, host read again",
        "acme live",
        "initech starts, replacing 1.4.7, after 6 jobs, host read again",
        "initech live",
      ]);
    } finally {
      await r.service.idle();
      await r.hosts.close();
      r.store.close();
    }
  });

  it("puts only the target that failed back to its version, and stops before the next one", async () => {
    const r = await gitlabWorld();
    try {
      // acme's deploy job fails once; the same job played again with the version before works.
      r.hosts.jobOutcomes.set("app:deploy:acme", ["failed"]);
      const deployer = new CaseDeployer(portsOf(r, ["backend/app/slips.py"]));
      const plan = await deployer.plan({ ...fix, about: ["Globex cannot print slips"] });
      if (!plan.ok) throw new Error(plan.why);
      const events: string[] = [];
      const done = await deployer.deployAll(
        { ...fix, about: ["Globex cannot print slips"], landed: false },
        plan,
        watch(r, events),
      );

      expect(done.targets.map((t) => [t.path.env.env, t.record.state])).toEqual([
        ["globex", "live"],
        ["acme", "rolled-back"],
      ]);
      expect(done.targets[1]?.record.rollback).toMatchObject({ ok: true });
      // Globex stays as it is, acme is played again with the version it ran before in a pipeline of its own, and initech
      // was never touched.
      expect(played(r)).toEqual([
        ["image:build:globex", { VERSION: "globex-2.0.4" }],
        ["app:deploy:globex", sent("globex", "globex-2.0.4")],
        ["app:status:globex", { TARGET: "globex" }],
        ["image:build:production", { VERSION: "1.4.8" }],
        ["app:deploy:acme", sent("acme", "1.4.8")],
        ["app:deploy:acme", sent("acme", "1.4.7")],
        ["app:status:acme", { TARGET: "acme" }],
      ]);
      const pipelines = r.hosts.played.map((p) => p.pipeline);
      expect(pipelines[5]).not.toBe(pipelines[4]);
      expect(events).toEqual([
        "globex starts, replacing globex-2.0.3, after 0 jobs, host read once",
        "globex live",
        "acme starts, replacing 1.4.7, after 3 jobs, host read again",
        "acme rolled-back",
      ]);
      // The incident and the owner's word say which target went back.
      expect(r.incidents.map((i) => i.record.env)).toEqual(["acme"]);

      // The case's rollback reaches the target that stayed live: each environment the case put live, the last first.
      const at = new Date().toISOString();
      const entry = (env: string, record: number, previous: string, state: "live" | "failed") => ({
        at,
        project: fix.project,
        env,
        branch: fix.branch,
        previous,
        commit: C2,
        record,
        state,
      });
      let kase = newCase({ room: "r1", client: "Ana", symptom: "no slips", at, day: "2026-10-22" });
      for (const target of done.targets) {
        const live = target.record.state === "live";
        kase = withDeploy(
          kase,
          entry(target.path.env.env, target.record.id, target.path.previous, live ? "live" : "failed"),
        );
      }
      expect(rollbackTargets(kase).map((d) => d.env)).toEqual(["globex"]);
      const globex = done.targets[0];
      if (globex === undefined) throw new Error("no first target");
      await deployer.rollback(globex.record.id);
      expect(r.store.deploys.get(globex.record.id)?.state).toBe("rolled-back");
      expect(played(r).slice(7)).toEqual([
        ["app:deploy:globex", sent("globex", "globex-2.0.3")],
        ["app:status:globex", { TARGET: "globex" }],
      ]);
      kase = withRollback(kase, { at, record: globex.record.id, to: globex.path.previous, ok: true });
      expect(rollbackTargets(kase)).toEqual([]);
    } finally {
      await r.service.idle();
      await r.hosts.close();
      r.store.close();
    }
  });
});

describe("which environments a fix goes to", () => {
  it("goes only to the environments that deploy the part the change touches, and says which were left out", async () => {
    const found = await discoverEnvironments({
      files: await acmeShopCi(ACME_SHOP_MONO_FILES),
      base: "main",
      provider: "gitlab",
      remote: "gitlab",
      folders: ACME_SHOP_MONO_FOLDERS,
      read: memoryCi(ACME_SHOP_MONO_FILES).read,
    });
    const r = await rig(found.environments, "github", { origin: "github", gitlab: "gitlab" });
    try {
      const deployer = new CaseDeployer(portsOf(r, undefined));
      // A change in the shop: its three targets, and the media node is left out with its reason.
      const shop = await deployer.order("storefront", { changed: ["apps/acme-api/app/slips.py"] });
      expect(shop).toMatchObject({ ok: true, envs: ["acme", "globex", "initech"] });
      expect(shop.ok && shop.left.map((l) => l.env)).toEqual(["media-eu-1"]);
      // A change in the other product: no environment of the shop gets it, and nothing deploys.
      const media = await deployer.order("storefront", { changed: ["apps/media-service/main.go"] });
      expect(media).toMatchObject({
        ok: false,
        why: expect.stringContaining("which no environment of the project deploys"),
      });
      // A change that belongs to no part (the docs) has nothing to narrow by: the shop's targets all go.
      const docs = await deployer.order("storefront", { changed: ["docs/readme.md"] });
      expect(docs).toMatchObject({ ok: true, envs: ["acme", "globex", "initech"] });
    } finally {
      await r.service.idle();
      await r.hosts.close();
      r.store.close();
    }
  });
});
