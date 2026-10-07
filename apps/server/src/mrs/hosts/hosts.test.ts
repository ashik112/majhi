import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, tempDir } from "../../testing/fixtures.ts";
import { type FakeBitbucket, fakeBitbucket, fakeHosts } from "../../testing/mrHosts.ts";
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

  it("refuses without credentials, and keeps a rejected token out of the error", async () => {
    const host = await setup("Bearer right");
    await expect(host.open(target(), mr)).rejects.toThrow(/No Bitbucket credentials/);
    const err = await host.open(target("wrong-token-xyz"), mr).catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain("401");
    expect(String((err as Error).message)).not.toContain("wrong-token-xyz");
  });
});
