import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, tempDir } from "../../testing/fixtures.ts";
import { type FakeBitbucket, fakeBitbucket, fakeHosts } from "../../testing/mrHosts.ts";
import { ciOf as bitbucketCi } from "./bitbucket.ts";
import { ciOf as githubCi } from "./github.ts";
import { ciOf as gitlabCi } from "./gitlab.ts";
import { createMrHosts, MrHostError, type MrTarget } from "./index.ts";

let cleanup: (() => Promise<void>) | undefined;
let bitbucket: FakeBitbucket | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await bitbucket?.close();
  bitbucket = undefined;
  await cleanup?.();
});

/** A bare "host" repo with `main` and a `feature` branch one commit ahead. */
async function hostedRepo(dir: string): Promise<string> {
  const bare = join(dir, "host.git");
  const work = join(dir, "work");
  await mkdir(work, { recursive: true });
  await git(dir, "init", "--bare", "--quiet", "--initial-branch=main", bare);
  await git(work, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(work, "a.txt"), "a\n");
  await git(work, "add", ".");
  await git(work, "commit", "--quiet", "-m", "init");
  await git(work, "checkout", "--quiet", "-b", "feature");
  await writeFile(join(work, "b.txt"), "b\n");
  await git(work, "add", ".");
  await git(work, "commit", "--quiet", "-m", "feature");
  await git(work, "push", "--quiet", bare, "main", "feature");
  return bare;
}

describe("ci mapping", () => {
  it("reads GitHub checks and statuses", () => {
    expect(githubCi([])).toBe("none");
    expect(githubCi([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("passing");
    expect(
      githubCi([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: "" },
      ]),
    ).toBe("pending");
    expect(githubCi([{ status: "IN_PROGRESS", conclusion: "" }, { conclusion: "FAILURE" }])).toBe("failing");
    expect(githubCi([{ state: "PENDING" }])).toBe("pending");
    expect(githubCi([{ conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }])).toBe("passing");
  });

  it("reads a GitLab pipeline", () => {
    expect(gitlabCi(undefined)).toBe("none");
    expect(gitlabCi(null)).toBe("none");
    expect(gitlabCi("success")).toBe("passing");
    expect(gitlabCi("failed")).toBe("failing");
    expect(gitlabCi("running")).toBe("pending");
    expect(gitlabCi("created")).toBe("pending");
  });

  it("reads Bitbucket build statuses", () => {
    expect(bitbucketCi([])).toBe("none");
    expect(bitbucketCi([{ state: "SUCCESSFUL" }])).toBe("passing");
    expect(bitbucketCi([{ state: "SUCCESSFUL" }, { state: "INPROGRESS" }])).toBe("pending");
    expect(bitbucketCi([{ state: "INPROGRESS" }, { state: "FAILED" }])).toBe("failing");
  });
});

describe("gh and glab", () => {
  async function setup() {
    const t = await tempDir();
    cleanup = t.cleanup;
    const fake = await fakeHosts(join(t.dir, "bin"));
    const bare = await hostedRepo(t.dir);
    await fake.addRepo("acme/api", bare);
    await fake.addRepo("acme/platform/web", bare);
    const hosts = createMrHosts({ bins: fake.bins });
    return { fake, hosts, bare };
  }
  const gh = (token?: string): MrTarget => ({
    host: "github",
    slug: "acme/api",
    ...(token ? { token } : {}),
  });
  const gl = (token?: string): MrTarget => ({
    host: "gitlab",
    slug: "acme/platform/web",
    ...(token ? { token } : {}),
  });
  const mr = { head: "feature", base: "main", title: "ACM-1: Add b", body: "Task ACM-1\n\nline two" };

  it("opens, edits, reads and merges a GitHub pull request", async () => {
    const { fake, hosts, bare } = await setup();
    const opened = await hosts.github.open(gh("tok-gh"), mr);
    expect(opened).toEqual({ url: "https://github.com/acme/api/pull/1", number: 1 });
    expect((await fake.state()).prs["acme/api"]?.[0]).toMatchObject({
      head: "feature",
      base: "main",
      title: mr.title,
      body: mr.body,
    });

    await hosts.github.updateDescription(gh("tok-gh"), 1, { title: mr.title, body: "new body" });
    expect((await fake.state()).prs["acme/api"]?.[0]?.body).toBe("new body");

    await fake.update((s) => {
      s.ci["acme/api"] = "pending";
    });
    expect(await hosts.github.status(gh("tok-gh"), 1)).toEqual({
      state: "open",
      ci: "pending",
      url: opened.url,
    });
    await fake.update((s) => {
      s.ci["acme/api"] = "passing";
    });
    expect((await hosts.github.status(gh("tok-gh"), 1)).ci).toBe("passing");

    await hosts.github.merge(gh("tok-gh"), 1);
    expect((await hosts.github.status(gh("tok-gh"), 1)).state).toBe("merged");
    expect(await git(bare, "rev-parse", "main")).toBe(await git(bare, "rev-parse", "feature"));
  });

  it("opens, edits, reads and merges a GitLab merge request in a nested group", async () => {
    const { fake, hosts } = await setup();
    const opened = await hosts.gitlab.open(gl("tok-gl"), mr);
    expect(opened).toEqual({ url: "https://gitlab.com/acme/platform/web/-/merge_requests/1", number: 1 });
    await hosts.gitlab.updateDescription(gl("tok-gl"), 1, { title: mr.title, body: "linked" });
    expect((await fake.state()).prs["acme/platform/web"]?.[0]?.body).toBe("linked");
    await fake.update((s) => {
      s.ci["acme/platform/web"] = "failing";
    });
    expect(await hosts.gitlab.status(gl("tok-gl"), 1)).toMatchObject({ state: "open", ci: "failing" });
    await hosts.gitlab.merge(gl("tok-gl"), 1);
    expect((await hosts.gitlab.status(gl("tok-gl"), 1)).state).toBe("merged");
  });

  it("gives the CLI its token for that call only, and none of majhi's own", async () => {
    const { fake, hosts } = await setup();
    vi.stubEnv("GH_TOKEN", "majhi-own-token");
    vi.stubEnv("GITHUB_TOKEN", "majhi-own-token-2");
    vi.stubEnv("GITLAB_TOKEN", "majhi-own-gitlab");
    await hosts.github.open(gh("org-token"), mr);
    await hosts.gitlab.open(gl(), { ...mr, title: "t2" });
    const [first, second] = (await fake.state()).calls;
    expect(first?.env).toEqual({ GH_TOKEN: "org-token" });
    expect(second?.env).toEqual({});
    // The token is never an argument.
    expect(JSON.stringify((await fake.state()).calls.map((c) => c.args))).not.toContain("org-token");
  });

  it("sends a self-hosted host name and hides the token in errors", async () => {
    const { fake, hosts } = await setup();
    await fake.update((s) => {
      s.requireToken["acme/api"] = "the-right-token";
    });
    const wrong = await hosts.github
      .open({ ...gh("secret-value-123"), hostName: "ghe.acme.dev" }, mr)
      .catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(MrHostError);
    expect(String((wrong as Error).message)).toContain("authentication required");
    expect(String((wrong as Error).message)).not.toContain("secret-value-123");
    expect((await fake.state()).calls[0]?.env).toEqual({
      GH_TOKEN: "secret-value-123",
      GH_HOST: "ghe.acme.dev",
    });
  });

  it("reports a merge the host refused", async () => {
    const { fake, hosts } = await setup();
    await hosts.github.open(gh("tok-merge"), mr);
    await fake.update((s) => {
      s.mergeFails["acme/api"] = "Pull request is not mergeable";
    });
    await expect(hosts.github.merge(gh("tok-merge"), 1)).rejects.toThrow(/not mergeable/);
  });
});

describe("Bitbucket Cloud", () => {
  async function setup(accept: string) {
    const t = await tempDir();
    cleanup = t.cleanup;
    bitbucket = await fakeBitbucket(accept);
    bitbucket.repos["acme/api"] = await hostedRepo(t.dir);
    return createMrHosts({ bitbucket: { api: bitbucket.url } }).bitbucket;
  }
  const target = (token?: string): MrTarget => ({
    host: "bitbucket",
    slug: "acme/api",
    ...(token ? { token } : {}),
  });
  const mr = { head: "feature", base: "main", title: "ACM-1: Add b", body: "body" };

  it("opens, edits, reads and merges with an app password (basic auth)", async () => {
    const basic = `Basic ${Buffer.from("owner:app-pass").toString("base64")}`;
    const host = await setup(basic);
    const opened = await host.open(target("owner:app-pass"), mr);
    expect(opened).toEqual({ url: "https://bitbucket.org/acme/api/pull-requests/1", number: 1 });
    expect(bitbucket?.requests[0]?.body).toMatchObject({
      title: mr.title,
      source: { branch: { name: "feature" } },
      destination: { branch: { name: "main" } },
    });

    await host.updateDescription(target("owner:app-pass"), 1, { title: mr.title, body: "linked" });
    expect(bitbucket?.prs.get(1)?.description).toBe("linked");

    if (bitbucket) bitbucket.ci = "passing";
    expect(await host.status(target("owner:app-pass"), 1)).toMatchObject({ state: "open", ci: "passing" });
    await host.merge(target("owner:app-pass"), 1);
    expect(await host.status(target("owner:app-pass"), 1)).toMatchObject({ state: "merged", ci: "none" });
  });

  it("uses a bearer token when it has no colon", async () => {
    const host = await setup("Bearer ws-token");
    await host.open(target("ws-token"), mr);
    expect(bitbucket?.requests[0]?.auth).toBe("Bearer ws-token");
  });

  it("refuses without credentials, and keeps a rejected token out of the error", async () => {
    const host = await setup("Bearer right");
    await expect(host.open(target(), mr)).rejects.toThrow(/No Bitbucket credentials/);
    const err = await host.open(target("wrong-token-xyz"), mr).catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain("401");
    expect(String((err as Error).message)).not.toContain("wrong-token-xyz");
  });
});
