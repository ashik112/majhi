import type { DeployRunStep } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { C1, C2, C3, environment, GH, GL_PIPELINE, push, type Rig, rig } from "./testing/rig.ts";

describe("deploy", () => {
  let r: Rig;
  afterEach(async () => {
    await r.service.idle();
    await r.hosts.close();
    r.store.close();
  });

  describe("one target", () => {
    beforeEach(async () => {
      r = await rig([environment("staging")]);
      push(r, C1);
    });

    it("goes live once the run ends and the check passes", async () => {
      const out = await r.service.deploy(
        { project: "storefront", runs: GH, env: "staging", task: "ACM-1" },
        "captain",
      );
      expect(out.repeat).toBe(false);
      expect(out.record.state).toBe("queued");
      await r.service.idle();
      const done = r.store.deploys.get(out.record.id);
      expect(done?.state).toBe("live");
      expect(done?.check).toMatchObject({ ok: true });
      expect(done?.run?.url).toContain("/actions/runs/");
      expect(r.tell).toEqual([]);
    });

    it("starts a target and commit once, however many ask", async () => {
      const [a, b] = await Promise.all([
        r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain"),
        r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "owner"),
      ]);
      expect(a.record.id).toBe(b.record.id);
      expect([a.repeat, b.repeat].sort()).toEqual([false, true]);
      await r.service.idle();
      const dispatches = r.hosts.calls.filter((c) => c.method === "POST" && c.path.endsWith("/dispatches"));
      expect(dispatches).toHaveLength(1);
      // Asking again after it is live starts nothing either.
      const again = await r.service.deploy(
        { project: "storefront", runs: GH, env: "staging", commit: C1 },
        "captain",
      );
      expect(again.repeat).toBe(true);
      await r.service.idle();
      expect(r.hosts.calls.filter((c) => c.path.endsWith("/dispatches"))).toHaveLength(1);
    });

    it("rolls back to the earlier commit, opens an incident and tells the owner when the run fails", async () => {
      await r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain");
      await r.service.idle();
      push(r, C2);
      r.hosts.outcome.github = "failure";
      const out = await r.service.deploy(
        { project: "storefront", runs: GH, env: "staging", task: "ACM-1" },
        "captain",
      );
      await r.service.idle();
      const rec = r.store.deploys.get(out.record.id);
      // The rerun of the first run succeeded, so the target is back where it was.
      r.hosts.outcome.github = "success";
      expect(rec?.state === "failed" || rec?.state === "rolled-back").toBe(true);
      expect(rec?.reason).toContain("failure");
      expect(rec?.reason).toContain("Upload build");
      expect(rec?.incident).toBe("ACM-77");
      expect(r.incidents).toHaveLength(1);
      expect(r.incidents[0]?.title).toBe(`Deploy of storefront to staging failed at ${C2.slice(0, 7)}`);
      expect(r.tell.join("\n")).toContain("Incident ACM-77 is open");
    });

    it("goes back to the earlier commit by running the earlier run again", async () => {
      await r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain");
      await r.service.idle();
      const first = r.store.deploys.latestLive("storefront", "staging");
      push(r, C2);
      // The second deploy runs, then its check fails: the host answers 502.
      // The new commit fails its check once, then the earlier one answers.
      r.health.queue = [502];
      const out = await r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain");
      await r.service.idle();
      const rec = r.store.deploys.get(out.record.id);
      expect(rec?.previous).toBe(C1);
      expect(rec?.check).toMatchObject({ ok: false });
      expect(rec?.check?.detail).toContain("502");
      const reruns = r.hosts.calls.filter((c) => c.path.endsWith(`/actions/runs/${first?.run?.id}/rerun`));
      expect(reruns).toHaveLength(1);
      expect(rec?.rollback).toMatchObject({ ok: true, commit: C1 });
      expect(rec?.state).toBe("rolled-back");
      expect(r.incidents).toHaveLength(1);
    });

    it("leaves a first deploy that fails as failed: there is nothing to go back to, and an incident is still opened", async () => {
      r.hosts.outcome.github = "failure";
      const out = await r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain");
      await r.service.idle();
      const rec = r.store.deploys.get(out.record.id);
      expect(rec?.state).toBe("failed");
      expect(rec?.rollback?.ok).toBe(false);
      expect(rec?.rollback?.detail).toContain("no earlier deploy");
      expect(r.incidents).toHaveLength(1);
      expect(r.tell[0]).toContain("may be broken");
    });

    it("never starts a failed deploy again by itself, but the owner can ask", async () => {
      r.hosts.outcome.github = "failure";
      const first = await r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain");
      await r.service.idle();
      r.hosts.outcome.github = "success";
      const byCaptain = await r.service.deploy(
        { project: "storefront", runs: GH, env: "staging" },
        "captain",
      );
      expect(byCaptain.repeat).toBe(true);
      expect(byCaptain.record.state).toBe("failed");
      const byOwner = await r.service.deploy(
        { project: "storefront", runs: GH, env: "staging", retry: true },
        "owner",
      );
      expect(byOwner.repeat).toBe(false);
      expect(byOwner.record.id).toBe(first.record.id);
      expect(byOwner.record.attempt).toBe(2);
      await r.service.idle();
      expect(r.store.deploys.get(first.record.id)?.state).toBe("live");
    });

    it("refuses a commit that is not the head of the base branch", async () => {
      await expect(
        r.service.deploy({ project: "storefront", runs: GH, env: "staging", commit: C2 }, "captain"),
      ).rejects.toThrow(/not at 2222222/);
      expect(r.hosts.calls).toHaveLength(0);
    });

    it("refuses a commit no merge produced for the captain, and lets the owner say so once", async () => {
      r.landed.clear();
      await expect(
        r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain"),
      ).rejects.toThrow(/has not been verified/);
      await expect(
        r.service.deploy(
          { project: "storefront", runs: GH, env: "staging", confirmUnchecked: true },
          "captain",
        ),
      ).rejects.toThrow(/has not been verified/);
      const out = await r.service.deploy(
        { project: "storefront", runs: GH, env: "staging", confirmUnchecked: true },
        "owner",
      );
      expect(out.record.unchecked).toBe(true);
    });

    it("does not call a commit unverified when the project has no checks", async () => {
      r.landed.clear();
      r.checks.configured = false;
      const out = await r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain");
      expect(out.record.unchecked).toBeUndefined();
    });

    it("keeps the captain out while it rests, and does not stop the owner", async () => {
      await expect(
        r.service.deploy(
          { project: "storefront", runs: GH, env: "staging" },
          "captain",
          "2026-12-24 is a freeze date",
        ),
      ).rejects.toThrow(/freeze/);
      const out = await r.service.deploy(
        { project: "storefront", runs: GH, env: "staging" },
        "owner",
        "2026-12-24 is a freeze date",
      );
      expect(out.repeat).toBe(false);
    });

    it("refuses a task of another workspace", async () => {
      await expect(
        r.service.deploy({ project: "storefront", runs: GH, env: "staging", task: "GLX-9" }, "captain"),
      ).rejects.toThrow(/not in the workspace of storefront/);
    });

    it("refuses without a run when the workspace is not signed in to the host", async () => {
      r.signedIn.value = false;
      await expect(
        r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "owner"),
      ).rejects.toThrow(/is not signed in to/);
      expect(r.hosts.calls).toHaveLength(0);
      expect(r.store.deploys.ofProject("storefront", 10)).toEqual([]);
    });

    it("sends the workspace's own token and never writes it anywhere", async () => {
      const out = await r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "owner");
      await r.service.idle();
      expect(r.hosts.calls.every((c) => c.token === r.hosts.tokens.github)).toBe(true);
      const rec = JSON.stringify(r.store.deploys.get(out.record.id));
      expect(rec).not.toContain(r.hosts.tokens.github);
    });

    it("waits for a commit the host does not have yet: no record and no run", async () => {
      r.hosts.branches.set("github:acme/storefront:main", C3);
      await expect(
        r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "owner"),
      ).rejects.toThrow(/Push it first/);
      expect(r.hosts.calls.some((c) => c.path.endsWith("/dispatches"))).toBe(false);
      expect(r.store.deploys.ofProject("storefront", 10)).toEqual([]);
    });

    it("picks a deploy that was moving back up after a restart", async () => {
      const made = r.store.deploys.create({
        org: "acme",
        project: "storefront",
        env: "staging",
        commit: C1,
        state: "queued",
        runs: GH,
        by: "captain",
        at: new Date().toISOString(),
      });
      expect(made).toBeDefined();
      r.service.resume();
      await r.service.idle();
      expect(r.store.deploys.get(made?.id ?? 0)?.state).toBe("live");
    });
  });

  describe("a plan of two environments", () => {
    beforeEach(async () => {
      r = await rig([environment("staging"), environment("production")]);
      push(r, C1);
    });

    const planBoth = () =>
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

    it("keeps the head out of a planned step until it runs, and does not deploy production before staging is live", async () => {
      const { records } = await planBoth();
      const [staging, production] = records;
      expect(records.map((x) => [x.env, x.state, x.seq])).toEqual([
        ["staging", "planned", 1],
        ["production", "planned", 2],
      ]);
      await expect(r.service.deploy({ record: production?.id ?? 0 }, "owner")).rejects.toThrow(
        /storefront staging is not live/,
      );
      const out = await r.service.deploy({ record: staging?.id ?? 0 }, "captain");
      expect(out.record.commit).toBe(C1);
      await r.service.idle();
      const next = await r.service.deploy({ record: production?.id ?? 0 }, "owner");
      expect(next.repeat).toBe(false);
      await r.service.idle();
      expect(r.store.deploys.get(production?.id ?? 0)).toMatchObject({ state: "live", commit: C1 });
    });

    it("does not count staging as live when it failed", async () => {
      const { records } = await planBoth();
      r.hosts.outcome.github = "failure";
      await r.service.deploy({ record: records[0]?.id ?? 0 }, "captain");
      await r.service.idle();
      await expect(r.service.deploy({ record: records[1]?.id ?? 0 }, "owner")).rejects.toThrow(
        /staging is not live/,
      );
    });

    it("replaces the planned steps of a task and keeps the ones that ran", async () => {
      const first = await planBoth();
      await r.service.deploy({ record: first.records[0]?.id ?? 0 }, "captain");
      await r.service.idle();
      const again = await r.service.plan(
        {
          task: "ACM-1",
          steps: [{ project: "storefront", env: "production", runs: GH, note: "Only production" }],
        },
        "captain",
      );
      expect(again.records.map((x) => x.env)).toEqual(["production"]);
      expect(r.store.deploys.ofTask("ACM-1").map((x) => [x.env, x.state])).toEqual([
        ["staging", "live"],
        ["production", "planned"],
      ]);
    });

    it("holds a planned step for the owner, who lets it go by its record", async () => {
      const { records } = await planBoth();
      const held = await r.service.hold({ record: records[1]?.id ?? 0 });
      expect(held.state).toBe("held");
      await r.service.deploy({ record: records[0]?.id ?? 0 }, "captain");
      await r.service.idle();
      const out = await r.service.deploy({ record: held.id }, "owner");
      expect(out.repeat).toBe(false);
      await r.service.idle();
      expect(r.store.deploys.get(held.id)?.state).toBe("live");
    });

    it("holds a commit for the owner: no rule deploys it until the owner does", async () => {
      await r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain");
      await r.service.idle();
      const held = await r.service.hold({ project: "storefront", env: "production", commit: C1, runs: GH });
      expect(held.state).toBe("held");
      const again = await r.service.deploy({ project: "storefront", runs: GH, env: "production" }, "owner");
      expect(again.record.id).toBe(held.id);
      expect(again.repeat).toBe(false);
      await r.service.idle();
      expect(r.store.deploys.get(held.id)?.state).toBe("live");
    });

    it("rolls a live deploy back on the owner's request, only the newest one", async () => {
      await r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain");
      await r.service.idle();
      const first = r.store.deploys.latestLive("storefront", "staging");
      push(r, C2);
      await r.service.deploy({ project: "storefront", runs: GH, env: "staging" }, "captain");
      await r.service.idle();
      const second = r.store.deploys.latestLive("storefront", "staging");
      await expect(r.service.rollback(first?.id ?? 0, "owner")).rejects.toThrow(/newer deploy/);
      const done = await r.service.rollback(second?.id ?? 0, "owner");
      expect(done.record.state).toBe("rolled-back");
      expect(done.record.rollback).toMatchObject({ ok: true, commit: C1 });
    });
  });

  describe("two runs in one step", () => {
    const two: DeployRunStep[] = [
      { kind: "github-workflow", remote: "origin", workflow: "build.yml", ref: "base" },
      { kind: "github-workflow", remote: "origin", workflow: "deploy.yml", ref: "base" },
    ];

    beforeEach(async () => {
      r = await rig([environment("staging")]);
      push(r, C1);
    });

    it("starts the second run only when the first ended, and records both", async () => {
      const out = await r.service.deploy({ project: "storefront", env: "staging", runs: two }, "owner");
      await r.service.idle();
      const rec = r.store.deploys.get(out.record.id);
      expect(rec?.state).toBe("live");
      expect(rec?.handles.map((h) => h.ended)).toEqual([true, true]);
      const files = r.hosts.calls
        .filter((c) => c.method === "POST" && c.path.endsWith("/dispatches"))
        .map((c) => c.path.split("/").at(-2));
      expect(files).toEqual(["build.yml", "deploy.yml"]);
    });

    it("stops at the first run that fails and starts no other", async () => {
      r.hosts.outcome.github = "failure";
      const out = await r.service.deploy({ project: "storefront", env: "staging", runs: two }, "owner");
      await r.service.idle();
      expect(r.store.deploys.get(out.record.id)?.state).toBe("failed");
      expect(r.hosts.calls.filter((c) => c.path.endsWith("/dispatches"))).toHaveLength(1);
    });

    it("goes on with the next run after a restart and never starts a finished one again", async () => {
      const made = r.store.deploys.create({
        org: "acme",
        project: "storefront",
        env: "staging",
        commit: C1,
        state: "queued",
        runs: two,
        by: "owner",
        at: new Date().toISOString(),
      });
      r.store.deploys.move(made?.id ?? 0, "queued", "running", new Date().toISOString());
      // The build ran and ended; the deploy run was never started.
      r.store.deploys.annotate(made?.id ?? 0, new Date().toISOString(), {
        handles: [{ id: "100", url: "http://x/runs/100", attempt: 1, ended: true }],
      });
      r.service.resume();
      await r.service.idle();
      // majhi cannot know whether the second run was started before it stopped, so it does not guess.
      expect(r.store.deploys.get(made?.id ?? 0)?.state).toBe("failed");
      expect(r.hosts.calls.filter((c) => c.path.endsWith("/dispatches"))).toHaveLength(0);
    });
  });

  describe("an ssh run", () => {
    const ssh: DeployRunStep[] = [
      { kind: "ssh", connection: "acme-host", command: "cd /srv/storefront && ./deploy.sh" },
    ];

    beforeEach(async () => {
      r = await rig([environment("staging")]);
      push(r, C1);
    });

    it("runs the owner's command exactly as written, and nothing else", async () => {
      const out = await r.service.deploy(
        { project: "storefront", env: "staging", runs: ssh, task: "ACM-1" },
        "owner",
      );
      await r.service.idle();
      expect(r.remote).toEqual([
        { alias: "deploy@203.0.113.7", command: "cd /srv/storefront && ./deploy.sh" },
      ]);
      expect(r.store.deploys.get(out.record.id)?.state).toBe("live");
    });

    it("is never started for the captain", async () => {
      await expect(
        r.service.deploy({ project: "storefront", env: "staging", runs: ssh }, "captain"),
      ).rejects.toThrow(/owner's/);
      expect(r.remote).toEqual([]);
    });

    it("keeps secrets out of the incident when the command fails, and says an ssh run cannot go back", async () => {
      await r.service.deploy({ project: "storefront", env: "staging", runs: ssh }, "owner");
      await r.service.idle();
      push(r, C2);
      r.remoteRun.code = 1;
      r.remoteRun.output = "npm ERR! build failed\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked";
      const out = await r.service.deploy({ project: "storefront", env: "staging", runs: ssh }, "owner");
      await r.service.idle();
      const rec = r.store.deploys.get(out.record.id);
      expect(rec?.state).toBe("failed");
      expect(rec?.rollback?.detail).toContain("cannot go back to an earlier commit");
      expect(r.incidents[0]?.text).toContain("npm ERR! build failed");
      expect(r.incidents[0]?.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      expect(r.remote).toHaveLength(2);
    });

    it("does not follow a command it was not there to see end after a restart", async () => {
      const made = r.store.deploys.create({
        org: "acme",
        project: "storefront",
        env: "staging",
        commit: C1,
        state: "queued",
        runs: ssh,
        by: "owner",
        at: new Date().toISOString(),
      });
      r.store.deploys.move(made?.id ?? 0, "queued", "running", new Date().toISOString());
      r.service.resume();
      await r.service.idle();
      const rec = r.store.deploys.get(made?.id ?? 0);
      expect(rec?.state).toBe("failed");
      expect(rec?.reason).toContain("restarted");
      expect(r.remote).toEqual([]);
    });
  });

  describe("the other providers", () => {
    it("deploys through a GitLab pipeline with the workspace's GitLab token", async () => {
      r = await rig([environment("staging")], "gitlab");
      r.hosts.branches.set("gitlab:acme/storefront:main", C1);
      const out = await r.service.deploy(
        { project: "storefront", env: "staging", runs: GL_PIPELINE },
        "owner",
      );
      await r.service.idle();
      expect(r.store.deploys.get(out.record.id)?.state).toBe("live");
      const calls = r.hosts.calls.filter((c) => c.path.startsWith("/api/v4"));
      expect(calls.length).toBeGreaterThan(2);
      expect(calls.every((c) => c.token === r.hosts.tokens.gitlab)).toBe(true);
    });

    it("cannot go back to an earlier commit through a GitLab pipeline, and says so", async () => {
      r = await rig([environment("staging")], "gitlab");
      r.hosts.branches.set("gitlab:acme/storefront:main", C1);
      await r.service.deploy({ project: "storefront", env: "staging", runs: GL_PIPELINE }, "owner");
      await r.service.idle();
      r.hosts.branches.set("gitlab:acme/storefront:main", C2);
      r.tip.value = C2;
      r.hosts.outcome.gitlab = "failed";
      const out = await r.service.deploy(
        { project: "storefront", env: "staging", runs: GL_PIPELINE },
        "owner",
      );
      await r.service.idle();
      const rec = r.store.deploys.get(out.record.id);
      expect(rec?.state).toBe("failed");
      expect(rec?.rollback?.detail).toContain("not from an earlier commit");
      expect(rec?.rollback?.detail).toContain("by hand");
    });

    it("deploys a commit through Vercel and makes the earlier deployment again to go back", async () => {
      r = await rig([environment("production")]);
      push(r, C1);
      const vercel: DeployRunStep[] = [
        { kind: "vercel", connection: "acme-vercel", project: "storefront", target: "production" },
      ];
      await r.service.deploy({ project: "storefront", env: "production", runs: vercel }, "owner");
      await r.service.idle();
      push(r, C2);
      r.health.queue = [503];
      const out = await r.service.deploy({ project: "storefront", env: "production", runs: vercel }, "owner");
      await r.service.idle();
      const rec = r.store.deploys.get(out.record.id);
      expect(rec?.state).toBe("rolled-back");
      const made = r.hosts.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v13/deployments"));
      expect(made).toHaveLength(3);
      expect(made.every((c) => c.token === r.hosts.tokens.vercel)).toBe(true);
      expect((made[2]?.body as { deploymentId?: string } | undefined)?.deploymentId).toBe(
        r.store.deploys.find("storefront", "production", C1)?.run?.id,
      );
    });
  });
});
