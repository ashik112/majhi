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
  for (let i = 0; i < 100; i++) {
    const poll = await h.cmd("git.signIn.poll", { signIn: start.body.signIn });
    if (poll.body.state !== "pending") return poll.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("sign-in did not end");
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
  it("signs in with gh through the host helper: its code on the page, the token for that workspace only", async () => {
    const { h, hosts, jobs } = await world({ gh: { token: TOKEN } });
    hosts.on("GET https://api.github.com/user", () => ({ json: { login: "octo-acme" } }));
    hosts.on("GET https://api.github.com/users/octo-acme", () => ({ json: {} }));
    const start = await h.cmd("git.signIn.start", { org: "acme", kind: "github" });
    expect(start.body).toMatchObject({ state: "device", userCode: "AB12-CD34", opened: true });
    expect(jobs.find((j) => j.method === "git.cliLogin")?.params).toMatchObject({
      cli: "gh",
      org: "acme",
      host: "github.com",
    });
    let done: { state: string } | undefined;
    for (let i = 0; i < 100 && done === undefined; i++) {
      const poll = await h.cmd("git.signIn.poll", { signIn: start.body.signIn });
      if (poll.body.state !== "pending") done = poll.body;
      else await new Promise((r) => setTimeout(r, 30));
    }
    expect(done).toMatchObject({ state: "done", account: "octo-acme" });
    const orgs = (await h.majhi.services.config.sections()).orgs;
    expect(
      await h.majhi.services.secrets.get((orgs.acme?.mr_tokens?.github ?? "").replace("secret:", "")),
    ).toBe(TOKEN);
    expect(orgs.private?.mr_tokens).toBeUndefined();
    expect(JSON.stringify(jobs.filter((j) => j.method !== "git.cliLogin"))).not.toContain(TOKEN);
  });

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
  async function bare(name: string): Promise<string> {
    if (w === undefined) throw new Error("no world");
    const src = join(w.h.dir, "src", name);
    await mkdir(src, { recursive: true });
    await git(src, "init", "--quiet", "--initial-branch=trunk");
    await writeFile(join(src, "README.md"), `# ${name}\n`);
    await git(src, "add", ".");
    await git(src, "commit", "--quiet", "-m", "first");
    const remote = join(w.h.dir, "remotes", `${name}.git`);
    await git(join(w.h.dir), "clone", "--quiet", "--bare", src, remote);
    return remote;
  }

  async function waitJob(h: World["h"], clone: string) {
    for (let i = 0; i < 200; i++) {
      const job = (await h.cmd("projects.cloneStatus", { clone })).body.jobs[0];
      if (job.state === "done" || job.state === "failed") return job;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("clone did not end");
  }

  it("clones into <root>/<workspace>/<repo> with the workspace token through the helper and registers it", async () => {
    const { h, hosts, urls, jobs } = await world();
    await signIn(h, hosts);
    urls.set("https://github.com/acme/demo.git", await bare("demo"));
    const start = await h.cmd("projects.clone", { org: "acme", kind: "github", fullName: "acme/demo" });
    expect(start.status).toBe(200);
    const path = join(h.dir, "Work", "acme", "demo");
    expect(start.body).toMatchObject({ path, project: "demo" });
    const job = await waitJob(h, start.body.clone);
    expect(job).toMatchObject({ state: "done", base: "trunk", path, project: "demo" });
    const clone = jobs.find((j) => j.method === "git.clone");
    expect(clone?.params).toEqual({
      clone: start.body.clone,
      url: "https://github.com/acme/demo.git",
      path,
      auth: { kind: "token", username: "x-access-token", password: TOKEN },
    });
    const project = (await h.cmd("projects.list")).body.find((p: { id: string }) => p.id === "demo");
    expect(project).toMatchObject({
      org: "acme",
      path,
      base: "trunk",
      remotes: { origin: { host: "github" } },
    });
  });

  it("refuses a folder that is not empty, a repo already registered, no token, nesting and no helper", async () => {
    const { h, hosts } = await world();
    const c = (body: Record<string, unknown>) =>
      h.cmd("projects.clone", { org: "acme", kind: "github", ...body });
    expect((await c({ fullName: "acme/demo" })).body.error).toMatch(/not signed in to github.com/);
    await signIn(h, hosts);
    await mkdir(join(h.dir, "Work", "acme", "full"), { recursive: true });
    await writeFile(join(h.dir, "Work", "acme", "full", "x"), "x");
    const full = await c({ fullName: "acme/full" });
    expect(full.status).toBe(409);
    expect(full.body.error).toMatch(/already exists and is not empty/);
    // acme-api's origin is a local path; give it a GitHub remote to be found by.
    await git(join(h.dir, "Work", "api"), "remote", "add", "gh", "git@github.com:Acme/API.git");
    const dup = await c({ fullName: "acme/api" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already the project acme-api/);
    expect((await c({ fullName: "acme/x", id: "acme-api" })).body.error).toMatch(/is taken/);
    await git(join(h.dir, "Work"), "init", "--quiet", "private");
    expect(
      (await h.cmd("projects.clone", { org: "private", kind: "github", fullName: "acme/x" })).body.error,
    ).toMatch(/is itself a git repo/);
    stopHelper?.();
    await new Promise((r) => setTimeout(r, 300));
    const offline = await c({ fullName: "acme/other" });
    expect(offline.body.error).toMatch(/host helper is not running/);
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

describe("new project, publish and connect", () => {
  it("creates <root>/<workspace>/<name> with a README committed as the workspace and registers it", async () => {
    const { h } = await world({ helper: false });
    await h.cmd("orgs.update", { id: "acme", identity: { name: "Acme Bot", email: "bot@acme.test" } });
    const made = await h.cmd("projects.create", { org: "acme", name: "demo", description: "A demo." });
    expect(made.status).toBe(200);
    const path = join(h.dir, "Work", "acme", "demo");
    expect(made.body.project).toMatchObject({ id: "demo", org: "acme", path, base: "main" });
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("# demo\n\nA demo.\n");
    expect(await git(path, "log", "--format=%an <%ae>|%cn|%s")).toBe(
      "Acme Bot <bot@acme.test>|Acme Bot|Initial commit",
    );
    expect(await git(path, "rev-parse", "HEAD")).toBe(made.body.commit);
    expect(await git(path, "symbolic-ref", "--short", "HEAD")).toBe("main");
    const again = await h.cmd("projects.create", { org: "acme", name: "demo", id: "demo-2" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already exists and is not empty/);
  });

  it("publishes: makes the private repo, sets origin without credentials and pushes main with the token", async () => {
    const { h, hosts, urls, jobs } = await world();
    await signIn(h, hosts);
    hosts.on("POST https://api.github.com/user/repos", (req) => ({
      status: 201,
      json: {
        full_name: "octo-acme/demo",
        name: "demo",
        owner: { login: "octo-acme" },
        private: (req.json as { private: boolean }).private,
        html_url: "https://github.com/octo-acme/demo",
        clone_url: "https://github.com/octo-acme/demo.git",
      },
    }));
    const remote = join(h.dir, "remotes", "demo.git");
    await mkdir(remote, { recursive: true });
    await git(remote, "init", "--bare", "--quiet");
    urls.set("https://github.com/octo-acme/demo.git", remote);
    await h.cmd("projects.create", { org: "acme", name: "demo" });
    const pub = await h.cmd("projects.publish", { id: "demo", kind: "github" });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({
      remote: { name: "origin", url: "https://github.com/octo-acme/demo.git", fullName: "octo-acme/demo" },
      pushed: "main",
      project: { remotes: { origin: { host: "github" } } },
    });
    const created = hosts.requests.find((r) => r.url === "https://api.github.com/user/repos");
    expect(created?.json).toEqual({ name: "demo", private: true, auto_init: false });
    const path = join(h.dir, "Work", "acme", "demo");
    expect(await git(path, "remote", "get-url", "origin")).toBe("https://github.com/octo-acme/demo.git");
    expect(await git(remote, "rev-parse", "main")).toBe(await git(path, "rev-parse", "main"));
    const push = jobs.find((j) => j.method === "git.push");
    expect(push?.params).toMatchObject({
      url: "https://github.com/octo-acme/demo.git",
      branch: "main",
      setUpstream: true,
      auth: { kind: "token", username: "x-access-token", password: TOKEN },
    });
    const audit = (await h.cmd("audit.list", {})).body;
    expect(JSON.stringify(audit)).toContain("Push of demo");
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    // A project with an origin is not published again.
    expect((await h.cmd("projects.publish", { id: "demo", kind: "github" })).body.error).toMatch(
      /already has an origin/,
    );
  });

  it("connects: pushes to an empty remote, and only fetches one that has commits", async () => {
    const { h, hosts, urls, jobs } = await world();
    await signIn(h, hosts);
    await h.cmd("projects.create", { org: "acme", name: "empty" });
    await h.cmd("projects.create", { org: "acme", name: "busy" });
    const emptyRemote = join(h.dir, "remotes", "empty.git");
    await mkdir(emptyRemote, { recursive: true });
    await git(emptyRemote, "init", "--bare", "--quiet");
    urls.set("https://github.com/acme/empty.git", emptyRemote);
    const pushed = await h.cmd("projects.connectRemote", {
      id: "empty",
      url: "https://github.com/acme/empty.git",
    });
    expect(pushed.status).toBe(200);
    expect(pushed.body).toMatchObject({ state: "pushed", pushed: "main", remote: { name: "origin" } });
    expect(await git(emptyRemote, "rev-parse", "main")).toBe(
      await git(join(h.dir, "Work", "acme", "empty"), "rev-parse", "main"),
    );

    const busySrc = join(h.dir, "src", "busy");
    await mkdir(busySrc, { recursive: true });
    await git(busySrc, "init", "--quiet", "--initial-branch=main");
    await git(busySrc, "commit", "--quiet", "--allow-empty", "-m", "theirs");
    const busyRemote = join(h.dir, "remotes", "busy.git");
    await git(h.dir, "clone", "--quiet", "--bare", busySrc, busyRemote);
    urls.set("https://github.com/acme/busy.git", busyRemote);
    const before = await git(busyRemote, "rev-parse", "main");
    const pushesBefore = jobs.filter((j) => j.method === "git.push").length;
    const connected = await h.cmd("projects.connectRemote", {
      id: "busy",
      url: "https://github.com/acme/busy.git",
    });
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ state: "connected", remoteBranch: "main" });
    expect(connected.body.detail).toBe(
      "The remote already has commits on main. majhi pushed nothing. Start a task to merge the two histories.",
    );
    expect(await git(busyRemote, "rev-parse", "main")).toBe(before);
    expect(jobs.filter((j) => j.method === "git.push")).toHaveLength(pushesBefore);

    expect(
      (await h.cmd("projects.connectRemote", { id: "busy", url: "https://github.com/acme/x.git" })).body
        .error,
    ).toMatch(/already has a remote named origin/);
    expect(
      (
        await h.cmd("projects.connectRemote", {
          id: "busy",
          url: "https://octo:tok@github.com/acme/x.git",
          remote: "up",
        })
      ).status,
    ).toBe(400);
  });
});
