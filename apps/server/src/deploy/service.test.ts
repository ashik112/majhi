import type { DeployRecord, DeployTarget } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RemoteRunFn } from "../connections/remote.ts";
import { Store } from "../store/index.ts";
import { createGitHubProvider } from "./github.ts";
import { createGitLabProvider } from "./gitlab.ts";
import { type DeployProject, DeployService } from "./service.ts";
import { createSshProvider } from "./ssh.ts";
import { type FakeHosts, startFakeHosts } from "./testing/fake-hosts.ts";
import type { DeployCredentials, ProviderDeps, Providers } from "./types.ts";
import { createVercelProvider } from "./vercel.ts";

const C1 = "1111111111111111111111111111111111111111";
const C2 = "2222222222222222222222222222222222222222";
const C3 = "3333333333333333333333333333333333333333";

const workflow = (env: string, over: Partial<DeployTarget> = {}): DeployTarget => ({
  env,
  via: { kind: "github-workflow", connection: "acme-github", workflow: "deploy.yml", ref: "base" },
  verify: { health: `https://${env}.acme.example/health`, waitSeconds: 0 },
  rollback: { kind: "redeploy-previous" },
  ...over,
});

interface Rig {
  store: Store;
  hosts: FakeHosts;
  service: DeployService;
  tell: string[];
  incidents: { title: string; text: string; record: DeployRecord }[];
  remote: { alias: string; command: string }[];
  /** What the base branch is at, per project. */
  tip: { value: string };
  landed: Set<string>;
  health: { status: number; queue: number[] };
  project: DeployProject;
  tasks: Map<string, { id: string; org: string | undefined }>;
  checks: { configured: boolean };
  remoteRun: { code: number | null; output: string };
}

async function rig(targets: DeployTarget[], provider: "github" | "gitlab" = "github"): Promise<Rig> {
  const hosts = await startFakeHosts();
  const store = new Store(":memory:");
  const tip = { value: C1 };
  const landed = new Set([C1, C2, C3]);
  const health = { status: 200, queue: [] as number[] };
  const tell: string[] = [];
  const incidents: Rig["incidents"] = [];
  const remote: Rig["remote"] = [];
  const remoteRun = { code: 0 as number | null, output: "" };
  const project: DeployProject = {
    id: "storefront",
    org: "acme",
    path: "/work/storefront",
    base: "main",
    remotes: {},
    targets,
  };
  const credentials: DeployCredentials = {
    git: async (org, connection) =>
      org === "acme" && connection === "acme-github"
        ? { token: hosts.tokens.github, host: hosts.host }
        : org === "acme" && connection === "acme-gitlab"
          ? { token: hosts.tokens.gitlab, host: hosts.host }
          : { problem: `${org} has no connection ${connection}` },
    variable: async (org, connection) =>
      org === "acme" && connection === "acme-vercel"
        ? { value: hosts.tokens.vercel }
        : { problem: `${org} has no connection ${connection}` },
    ssh: async (org, connection) =>
      org === "acme" && connection === "acme-host"
        ? { alias: "deploy@203.0.113.7" }
        : { problem: `${org} has no connection ${connection}` },
  };
  const run: RemoteRunFn = async (alias, command) => {
    remote.push({ alias, command });
    return remoteRun;
  };
  const providerDeps: ProviderDeps = {
    fetch,
    credentials,
    remote: run,
    sleep: async () => undefined,
    now: () => new Date(),
    vercelApi: hosts.url,
  };
  const providers: Providers = {
    "github-workflow": createGitHubProvider(providerDeps),
    "gitlab-pipeline": createGitLabProvider(providerDeps),
    vercel: createVercelProvider(providerDeps),
    ssh: createSshProvider(providerDeps),
  };
  const tasks: Rig["tasks"] = new Map([
    ["ACM-1", { id: "ACM-1", org: "acme" }],
    ["GLX-9", { id: "GLX-9", org: "globex" }],
  ]);
  const checks = { configured: true };
  const service = new DeployService({
    repo: store.deploys,
    projects: { get: async () => ({ ...project, targets: project.targets }) },
    tasks: { get: (id) => tasks.get(id), landedCommits: () => landed },
    git: { tip: async () => tip.value },
    repoRef: async () => ({ provider, slug: "acme/storefront" }),
    checksConfigured: () => checks.configured,
    providers,
    providerDeps,
    looks: {
      health: async () => ({ status: health.queue.shift() ?? health.status }),
      watch: async () => ({ ok: true, detail: "ok" }),
    },
    openIncident: async (input) => {
      incidents.push({ title: input.title, text: input.text, record: input.record });
      return "ACM-77";
    },
    tellOwner: (_org, _key, text) => tell.push(text),
    audit: () => undefined,
    changed: () => undefined,
    now: () => new Date(),
    sleep: async () => undefined,
    pollMs: 1,
    verifyMs: 1,
    runTimeoutMs: 60_000,
  });
  return {
    store,
    hosts,
    service,
    tell,
    incidents,
    remote,
    tip,
    landed,
    health,
    project,
    tasks,
    checks,
    remoteRun,
  };
}

/** Points the fake GitHub's main at the commit, as a push does. */
function push(r: Rig, sha: string) {
  r.hosts.branches.set("github:acme/storefront:main", sha);
  r.tip.value = sha;
}

describe("deploy", () => {
  let r: Rig;
  afterEach(async () => {
    await r.service.idle();
    await r.hosts.close();
    r.store.close();
  });

  describe("one target", () => {
    beforeEach(async () => {
      r = await rig([workflow("staging")]);
      push(r, C1);
    });

    it("goes live once the run ends and the check passes", async () => {
      const out = await r.service.deploy({ project: "storefront", env: "staging", task: "ACM-1" }, "captain");
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
        r.service.deploy({ project: "storefront", env: "staging" }, "captain"),
        r.service.deploy({ project: "storefront", env: "staging" }, "owner"),
      ]);
      expect(a.record.id).toBe(b.record.id);
      expect([a.repeat, b.repeat].sort()).toEqual([false, true]);
      await r.service.idle();
      const dispatches = r.hosts.calls.filter((c) => c.method === "POST" && c.path.endsWith("/dispatches"));
      expect(dispatches).toHaveLength(1);
      // Asking again after it is live starts nothing either.
      const again = await r.service.deploy({ project: "storefront", env: "staging", commit: C1 }, "captain");
      expect(again.repeat).toBe(true);
      await r.service.idle();
      expect(r.hosts.calls.filter((c) => c.path.endsWith("/dispatches"))).toHaveLength(1);
    });

    it("rolls back to the earlier commit, opens an incident and tells the owner when the run fails", async () => {
      await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      await r.service.idle();
      push(r, C2);
      r.hosts.outcome.github = "failure";
      const out = await r.service.deploy({ project: "storefront", env: "staging", task: "ACM-1" }, "captain");
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
      await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      await r.service.idle();
      const first = r.store.deploys.latestLive("storefront", "staging");
      push(r, C2);
      // The second deploy runs, then its check fails: the host answers 502.
      // The new commit fails its check once, then the earlier one answers.
      r.health.queue = [502];
      const out = await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
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
      const out = await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
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
      const first = await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      await r.service.idle();
      r.hosts.outcome.github = "success";
      const byCaptain = await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      expect(byCaptain.repeat).toBe(true);
      expect(byCaptain.record.state).toBe("failed");
      const byOwner = await r.service.deploy({ project: "storefront", env: "staging", retry: true }, "owner");
      expect(byOwner.repeat).toBe(false);
      expect(byOwner.record.id).toBe(first.record.id);
      expect(byOwner.record.attempt).toBe(2);
      await r.service.idle();
      expect(r.store.deploys.get(first.record.id)?.state).toBe("live");
    });

    it("refuses a commit that is not the head of the base branch", async () => {
      await expect(
        r.service.deploy({ project: "storefront", env: "staging", commit: C2 }, "captain"),
      ).rejects.toThrow(/not at 2222222/);
      expect(r.hosts.calls).toHaveLength(0);
    });

    it("refuses a commit no merge produced for the captain, and lets the owner say so once", async () => {
      r.landed.clear();
      await expect(r.service.deploy({ project: "storefront", env: "staging" }, "captain")).rejects.toThrow(
        /has not been verified/,
      );
      await expect(
        r.service.deploy({ project: "storefront", env: "staging", confirmUnchecked: true }, "captain"),
      ).rejects.toThrow(/has not been verified/);
      const out = await r.service.deploy(
        { project: "storefront", env: "staging", confirmUnchecked: true },
        "owner",
      );
      expect(out.record.unchecked).toBe(true);
    });

    it("does not call a commit unverified when the project has no checks", async () => {
      r.landed.clear();
      r.checks.configured = false;
      const out = await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      expect(out.record.unchecked).toBeUndefined();
    });

    it("keeps the captain out while it rests, and does not stop the owner", async () => {
      await expect(
        r.service.deploy({ project: "storefront", env: "staging" }, "captain", "2026-12-24 is a freeze date"),
      ).rejects.toThrow(/freeze/);
      const out = await r.service.deploy(
        { project: "storefront", env: "staging" },
        "owner",
        "2026-12-24 is a freeze date",
      );
      expect(out.repeat).toBe(false);
    });

    it("refuses a task of another workspace", async () => {
      await expect(
        r.service.deploy({ project: "storefront", env: "staging", task: "GLX-9" }, "captain"),
      ).rejects.toThrow(/not in the workspace of storefront/);
    });

    it("fails without calling the host when the workspace has no such connection", async () => {
      r.project.targets = [
        workflow("staging", {
          via: { kind: "github-workflow", connection: "globex-github", workflow: "deploy.yml", ref: "base" },
        }),
      ];
      const out = await r.service.deploy({ project: "storefront", env: "staging" }, "owner");
      await r.service.idle();
      const rec = r.store.deploys.get(out.record.id);
      expect(rec?.state).toBe("failed");
      expect(rec?.reason).toBe("acme has no connection globex-github");
      expect(r.hosts.calls).toHaveLength(0);
    });

    it("sends the connection's own token and never writes it anywhere", async () => {
      const out = await r.service.deploy({ project: "storefront", env: "staging" }, "owner");
      await r.service.idle();
      expect(r.hosts.calls.every((c) => c.token === r.hosts.tokens.github)).toBe(true);
      const rec = JSON.stringify(r.store.deploys.get(out.record.id));
      expect(rec).not.toContain(r.hosts.tokens.github);
    });

    it("refuses a branch the host does not have at the commit, before any run starts", async () => {
      r.hosts.branches.set("github:acme/storefront:main", C3);
      const out = await r.service.deploy({ project: "storefront", env: "staging" }, "owner");
      await r.service.idle();
      const rec = r.store.deploys.get(out.record.id);
      expect(rec?.state).toBe("failed");
      expect(rec?.reason).toContain("Push it first");
      expect(r.hosts.calls.some((c) => c.path.endsWith("/dispatches"))).toBe(false);
      // Nothing was deployed, so nothing was rolled back.
      expect(rec?.rollback).toBeUndefined();
    });

    it("picks a deploy that was moving back up after a restart", async () => {
      const made = r.store.deploys.create({
        org: "acme",
        project: "storefront",
        env: "staging",
        commit: C1,
        state: "queued",
        by: "captain",
        at: new Date().toISOString(),
      });
      expect(made).toBeDefined();
      r.service.resume();
      await r.service.idle();
      expect(r.store.deploys.get(made?.id ?? 0)?.state).toBe("live");
    });
  });

  describe("two targets", () => {
    beforeEach(async () => {
      r = await rig([workflow("staging"), workflow("production")]);
      push(r, C1);
    });

    it("does not deploy production before staging is live at that commit", async () => {
      await expect(r.service.deploy({ project: "storefront", env: "production" }, "owner")).rejects.toThrow(
        /staging is not live at 1111111 yet/,
      );
      await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      await r.service.idle();
      const out = await r.service.deploy({ project: "storefront", env: "production" }, "owner");
      expect(out.repeat).toBe(false);
      await r.service.idle();
      expect(r.store.deploys.get(out.record.id)?.state).toBe("live");
    });

    it("does not count staging as live when it failed", async () => {
      r.hosts.outcome.github = "failure";
      await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      await r.service.idle();
      await expect(r.service.deploy({ project: "storefront", env: "production" }, "owner")).rejects.toThrow(
        /staging is not live/,
      );
    });

    it("holds a commit for the owner: no rule deploys it until the owner does", async () => {
      await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      await r.service.idle();
      const held = await r.service.hold({ project: "storefront", env: "production", commit: C1 });
      expect(held.state).toBe("held");
      const again = await r.service.deploy({ project: "storefront", env: "production" }, "owner");
      expect(again.record.id).toBe(held.id);
      expect(again.repeat).toBe(false);
      await r.service.idle();
      expect(r.store.deploys.get(held.id)?.state).toBe("live");
    });

    it("rolls a live deploy back on the owner's request, only the newest one", async () => {
      await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      await r.service.idle();
      const first = r.store.deploys.latestLive("storefront", "staging");
      push(r, C2);
      await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      await r.service.idle();
      const second = r.store.deploys.latestLive("storefront", "staging");
      await expect(r.service.rollback(first?.id ?? 0, "owner")).rejects.toThrow(/newer deploy/);
      const done = await r.service.rollback(second?.id ?? 0, "owner");
      expect(done.record.state).toBe("rolled-back");
      expect(done.record.rollback).toMatchObject({ ok: true, commit: C1 });
    });
  });

  describe("an ssh target", () => {
    const sshTarget = (): DeployTarget => ({
      env: "staging",
      via: { kind: "ssh", connection: "acme-host", command: "cd /srv/storefront && ./deploy.sh" },
      verify: { health: "https://staging.acme.example/health", waitSeconds: 0 },
      rollback: { kind: "ssh", connection: "acme-host", command: "cd /srv/storefront && ./rollback.sh" },
    });

    beforeEach(async () => {
      r = await rig([sshTarget()]);
      push(r, C1);
    });

    it("runs the owner's command exactly as written, and nothing else", async () => {
      const out = await r.service.deploy({ project: "storefront", env: "staging", task: "ACM-1" }, "captain");
      await r.service.idle();
      expect(r.remote).toEqual([
        { alias: "deploy@203.0.113.7", command: "cd /srv/storefront && ./deploy.sh" },
      ]);
      expect(r.store.deploys.get(out.record.id)?.state).toBe("live");
    });

    it("runs the owner's rollback command when the command fails, and keeps secrets out of the incident", async () => {
      r.remoteRun.code = 1;
      r.remoteRun.output = "npm ERR! build failed\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked";
      const out = await r.service.deploy({ project: "storefront", env: "staging" }, "captain");
      await r.service.idle();
      expect(r.remote.map((c) => c.command)).toEqual([
        "cd /srv/storefront && ./deploy.sh",
        "cd /srv/storefront && ./rollback.sh",
      ]);
      const rec = r.store.deploys.get(out.record.id);
      expect(rec?.state).toBe("failed");
      expect(r.incidents[0]?.text).toContain("npm ERR! build failed");
      expect(r.incidents[0]?.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    });

    it("does not follow a command it was not there to see end after a restart", async () => {
      const made = r.store.deploys.create({
        org: "acme",
        project: "storefront",
        env: "staging",
        commit: C1,
        state: "queued",
        by: "captain",
        at: new Date().toISOString(),
      });
      r.store.deploys.move(made?.id ?? 0, "queued", "running", new Date().toISOString());
      r.service.resume();
      await r.service.idle();
      const rec = r.store.deploys.get(made?.id ?? 0);
      // The owner's rollback command ran and worked, so the target is back.
      expect(rec?.state).toBe("rolled-back");
      expect(rec?.reason).toContain("restarted");
    });
  });

  describe("the other providers", () => {
    it("deploys through a GitLab pipeline with the workspace's GitLab token", async () => {
      r = await rig(
        [workflow("staging", { via: { kind: "gitlab-pipeline", connection: "acme-gitlab", ref: "base" } })],
        "gitlab",
      );
      r.hosts.branches.set("gitlab:acme/storefront:main", C1);
      const out = await r.service.deploy({ project: "storefront", env: "staging" }, "owner");
      await r.service.idle();
      expect(r.store.deploys.get(out.record.id)?.state).toBe("live");
      const calls = r.hosts.calls.filter((c) => c.path.startsWith("/api/v4"));
      expect(calls.length).toBeGreaterThan(2);
      expect(calls.every((c) => c.token === r.hosts.tokens.gitlab)).toBe(true);
    });

    it("cannot go back to an earlier commit through GitLab, and says so", async () => {
      r = await rig(
        [workflow("staging", { via: { kind: "gitlab-pipeline", connection: "acme-gitlab", ref: "base" } })],
        "gitlab",
      );
      r.hosts.branches.set("gitlab:acme/storefront:main", C1);
      r.hosts.outcome.gitlab = "failed";
      const out = await r.service.deploy({ project: "storefront", env: "staging" }, "owner");
      await r.service.idle();
      const rec = r.store.deploys.get(out.record.id);
      expect(rec?.state).toBe("failed");
      expect(rec?.rollback?.detail).toContain("Write the rollback command");
    });

    it("deploys a commit through Vercel and makes the earlier deployment again to go back", async () => {
      r = await rig([
        workflow("production", {
          via: { kind: "vercel", connection: "acme-vercel", project: "storefront", target: "production" },
        }),
      ]);
      push(r, C1);
      await r.service.deploy({ project: "storefront", env: "production" }, "owner");
      await r.service.idle();
      push(r, C2);
      r.health.queue = [503];
      const out = await r.service.deploy({ project: "storefront", env: "production" }, "owner");
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
