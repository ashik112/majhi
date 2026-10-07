import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostJob } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { HostLink } from "../host/link.ts";
import { git } from "../testing/fixtures.ts";
import { type FakeGitHosts, fakeGitHosts } from "../testing/gitHosts.ts";
import { taskWorld, type World } from "../testing/world.ts";

const TOKEN = "gho_IntegrationSecret0123456789";

let w: World | undefined;
let stopHelper: (() => void) | undefined;
afterEach(async () => {
  stopHelper?.();
  await w?.cleanup();
  w = undefined;
  stopHelper = undefined;
});

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/**
 * Polls `read` until it returns a value. It has no deadline of its own: the test's timeout is the only clock.
 */
async function until<T>(_what: string, read: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
}

/**
 * Plays the host helper on this machine: clones, pushes and ls-remotes against local bare repos,
 * mapping each https URL to its bare repo. Records every job.
 */
function playHelper(
  link: HostLink,
  urls: Map<string, string>,
  fail?: { clone?: string },
  gh?: { token: string },
) {
  let stopped = false;
  const jobs: HostJob[] = [];
  const local = (url: string) => urls.get(url) ?? url;
  void (async () => {
    while (!stopped) {
      const job = await link.poll({ version: "t", platform: "linux", canRemount: false });
      if (job === undefined) continue;
      jobs.push(job);
      try {
        if (job.method === "openUrl") {
          link.reply({ id: job.id, ok: true, result: { opened: true } });
        } else if (job.method === "git.cliLogin") {
          // A computer without gh, unless this test plays one that the owner approves at once.
          if (gh === undefined) {
            link.reply({ id: job.id, ok: true, result: { state: "missing" } });
            continue;
          }
          link.progress({ id: job.id, login: { url: "https://github.com/login/device", code: "AB12-CD34" } });
          await new Promise((r) => setTimeout(r, 50));
          link.reply({ id: job.id, ok: true, result: { state: "done", token: gh.token } });
        } else if (job.method === "git.clone") {
          if (fail?.clone !== undefined) {
            link.reply({ id: job.id, ok: false, error: fail.clone });
            continue;
          }
          link.progress({ id: job.id, phase: "receiving", percent: 50 });
          await mkdir(dirname(job.params.path), { recursive: true });
          await git(dirname(job.params.path), "clone", "--quiet", local(job.params.url), job.params.path);
          const head = await git(job.params.path, "rev-parse", "HEAD");
          const branch = await git(job.params.path, "symbolic-ref", "--short", "HEAD");
          link.reply({ id: job.id, ok: true, result: { head, branch } });
        } else if (job.method === "git.push") {
          const b = job.params.branch;
          await git(
            job.params.path,
            "push",
            "--quiet",
            local(job.params.url),
            `refs/heads/${b}:refs/heads/${b}`,
          );
          link.reply({ id: job.id, ok: true, result: { pushed: true } });
        } else if (job.method === "git.lsRemote") {
          const out = await git("/", "ls-remote", "--symref", local(job.params.url));
          const head = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out)?.[1];
          link.reply({
            id: job.id,
            ok: true,
            result: {
              empty: !out.includes("refs/heads/"),
              ...(head === undefined ? {} : { defaultBranch: head }),
            },
          });
        } else link.reply({ id: job.id, ok: false, error: "not in this test" });
      } catch (err) {
        link.reply({ id: job.id, ok: false, error: `helper failed: ${String(err)}` });
      }
    }
  })();
  stopHelper = () => {
    stopped = true;
    link.close();
  };
  return jobs;
}

async function world(options: { helper?: boolean; fail?: { clone?: string }; gh?: { token: string } } = {}) {
  const hosts = fakeGitHosts();
  const urls = new Map<string, string>();
  const link = new HostLink({ pollTimeoutMs: 20, connectedWindowMs: 200 });
  const jobs = options.helper === false ? [] : playHelper(link, urls, options.fail, options.gh);
  w = await taskWorld({ hostLink: link, gitFetch: hosts.fetch, noAgent: true });
  await new Promise((r) => setTimeout(r, 30));
  return { w, h: w.h, hosts, urls, jobs };
}

/** Signs acme in to GitHub through the commands, with a fake GitHub that answers at once. */
async function signIn(h: World["h"], hosts: FakeGitHosts, account = "octo-acme") {
  hosts.on("POST https://github.com/login/device/code", () => ({
    json: {
      device_code: "dev-code-1",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 1,
    },
  }));
  hosts.on("POST https://github.com/login/oauth/access_token", () => ({ json: { access_token: TOKEN } }));
  hosts.on("GET https://api.github.com/user", () => ({ json: { login: account } }));
  hosts.on("GET https://api.github.com/users/octo-acme", () => ({ json: {} }));
  expect((await h.cmd("git.oauthApps.set", { kind: "github", clientId: "Ov23liAcmeExample01" })).status).toBe(
    200,
  );
  const start = await h.cmd("git.signIn.start", { org: "acme", kind: "github" });
  expect(start.body).toMatchObject({ state: "device", opened: true });
  return until("sign-in", async () => {
    const poll = await h.cmd("git.signIn.poll", { signIn: start.body.signIn });
    return poll.body.state === "pending" ? undefined : poll.body;
  });
}

describe("OAuth apps", () => {
  it("a Bitbucket API token pasted with the email is checked, saved in secrets.age only, never returned", async () => {
    const { h, hosts } = await world({ helper: false });
    const BB = "ATATTIntegrationBitbucket0099";
    const good = `Basic ${Buffer.from(`dev@acme.test:${BB}`).toString("base64")}`;
    hosts.on("GET https://api.bitbucket.org/2.0/user", (req) =>
      req.headers.authorization === good ? { json: { username: "acme-bb" } } : { status: 401, json: {} },
    );
    const start = await h.cmd("git.signIn.start", { org: "acme", kind: "bitbucket" });
    expect(start.body).toEqual({
      state: "paste",
      kind: "bitbucket",
      host: "bitbucket.org",
      reason: "bitbucket",
    });
    const saved = await h.cmd("git.signIn.token", {
      org: "acme",
      kind: "bitbucket",
      email: "dev@acme.test",
      token: BB,
    });
    expect(saved.body).toMatchObject({ state: "done", account: "acme-bb" });
    expect(JSON.stringify(saved.body)).not.toContain(BB);
    const yaml = await readFile(join(h.env.majhiHome, "majhi.yaml"), "utf8");
    expect(yaml).not.toContain(BB);
    const ref = (await h.majhi.services.config.sections()).orgs.acme?.mr_tokens?.bitbucket ?? "";
    expect(await h.majhi.services.secrets.get(ref.replace("secret:", ""))).toBe(`dev@acme.test:${BB}`);
    expect((await h.cmd("git.signIn.token", { org: "acme", kind: "bitbucket", token: BB })).status).toBe(400);
  });

  it("refuses an agent, and the sign-in commands too", async () => {
    const { h } = await world({ helper: false });
    const agent = { actor: { kind: "agent", id: "acme-builder" } };
    expect(
      (await h.cmd("git.oauthApps.set", { kind: "github", clientId: "Ov23liAcmeExample01" }, agent)).status,
    ).toBe(409);
    expect((await h.cmd("git.signIn.start", { org: "acme", kind: "github" }, agent)).status).toBe(409);
    expect(
      (await h.cmd("git.signIn.token", { org: "acme", kind: "github", token: "ghp_AgentToken123" }, agent))
        .status,
    ).toBe(409);
  });
});

describe("sign-in through the commands", () => {
  it("saves the token for that workspace in secrets.age and points its git account and mr_tokens at it", async () => {
    const { h, hosts } = await world();
    const done = await signIn(h, hosts);
    expect(done).toMatchObject({ state: "done", org: "acme", account: "octo-acme", alsoUsedBy: [] });
    const yaml = await readFile(join(h.env.majhiHome, "majhi.yaml"), "utf8");
    expect(yaml).not.toContain(TOKEN);
    const acme = (await h.majhi.services.config.sections()).orgs.acme;
    const ref = acme?.mr_tokens?.github ?? "";
    expect(acme?.git_accounts).toEqual([{ host: "github.com", account: "octo-acme", token: ref }]);
    expect(await h.majhi.services.secrets.get(ref.replace("secret:", ""))).toBe(TOKEN);
    expect((await h.majhi.services.config.sections()).orgs.private?.mr_tokens).toBeUndefined();
    const status = await h.cmd("onboarding.status");
    expect(status.body.workspaces.find((x: { id: string }) => x.id === "acme")).toMatchObject({
      git: [{ kind: "github", host: "github.com", account: "octo-acme", signedIn: true }],
      projects: 1,
    });
    expect(status.body.hostHelper).toBe(true);
  });
});

describe("clone", () => {
  function waitJob(h: World["h"], clone: string) {
    return until("clone", async () => {
      const job = (await h.cmd("projects.cloneStatus", { clone })).body.jobs[0];
      return job.state === "done" || job.state === "failed" ? job : undefined;
    });
  }

  it("refuses a folder that is not empty, a repo already registered, no token, nesting and no helper", async () => {
    const { h, hosts } = await world();
    const c = (body: Record<string, unknown>) =>
      h.cmd("projects.clone", { org: "acme", kind: "github", ...body });
    expect((await c({ fullName: "acme/demo" })).body.error).toBeTruthy();
    await signIn(h, hosts);
    await mkdir(join(h.dir, "Work", "acme", "full"), { recursive: true });
    await writeFile(join(h.dir, "Work", "acme", "full", "x"), "x");
    const full = await c({ fullName: "acme/full" });
    expect(full.status).toBe(409);
    expect(full.body.error).toBeTruthy();
    // acme-api's origin is a local path; give it a GitHub remote to be found by.
    await git(join(h.dir, "Work", "api"), "remote", "add", "gh", "git@github.com:Acme/API.git");
    const dup = await c({ fullName: "acme/api" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBeTruthy();
    expect((await c({ fullName: "acme/x", id: "acme-api" })).body.error).toBeTruthy();
    await git(join(h.dir, "Work"), "init", "--quiet", "private");
    expect(
      (await h.cmd("projects.clone", { org: "private", kind: "github", fullName: "acme/x" })).body.error,
    ).toBeTruthy();
    stopHelper?.();
    await new Promise((r) => setTimeout(r, 300));
    const offline = await c({ fullName: "acme/other" });
    expect(offline.body.error).toBeTruthy();
  });

  it("a failed clone ends failed with the helper's sentence and leaves no folder", async () => {
    const { h, hosts } = await world({
      fail: { clone: "The repo was not found, or the workspace's account cannot see it." },
    });
    await signIn(h, hosts);
    const start = await h.cmd("projects.clone", { org: "acme", kind: "github", fullName: "acme/missing" });
    const job = await waitJob(h, start.body.clone);
    expect(job).toMatchObject({
      state: "failed",
      reason: "The repo was not found, or the workspace's account cannot see it.",
    });
    expect(await exists(join(h.dir, "Work", "acme", "missing"))).toBe(false);
    expect((await h.cmd("projects.list")).body.map((p: { id: string }) => p.id)).toEqual(["acme-api"]);
  });
});
