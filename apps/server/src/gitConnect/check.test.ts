import type { CommandMeta, OrgConfig, SignInStatus } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { assertHostAllowed } from "../connect/self-host.ts";
import { UserError } from "../errors.ts";
import { type FakeAnswer, fakeGitHosts } from "../testing/gitHosts.ts";
import { checkGitToken } from "./check.ts";
import { SignInService } from "./signIn.ts";

const TOKEN = "ghp_SecretAcmeToken0123456789";
const OWNER: CommandMeta = { actor: { kind: "owner" } };

const ok = (json: unknown): FakeAnswer => ({ json });
const bearer = (req: { headers: Record<string, string> }) => req.headers.authorization === `Bearer ${TOKEN}`;

describe("checkGitToken: two real calls, decided by status", () => {
  it("GitHub.com: who the token is, then one repository", async () => {
    const hosts = fakeGitHosts({
      "GET https://api.github.com/user": (req) => (bearer(req) ? ok({ login: "acme-dev" }) : { status: 401 }),
      "GET https://api.github.com/user/repos": () => ok([{ name: "api" }]),
    });
    const result = await checkGitToken(hosts.fetch, "github", "github.com", TOKEN);
    expect(result).toEqual({
      ok: true,
      account: "acme-dev",
      checked: ["Asked github.com who the token belongs to", "Listed one repository"],
    });
    expect(hosts.requests.map((r) => r.url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/user/repos?per_page=1",
    ]);
    expect(hosts.requests.every((r) => !r.url.includes(TOKEN))).toBe(true);
  });

  it("GitHub Enterprise: the API is under the host's /api/v3", async () => {
    const hosts = fakeGitHosts({
      "GET https://ghe.acme.test/api/v3/user": () => ok({ login: "acme-dev" }),
      "GET https://ghe.acme.test/api/v3/user/repos": () => ok([]),
    });
    const result = await checkGitToken(hosts.fetch, "github", "ghe.acme.test", TOKEN);
    expect(result).toMatchObject({ ok: true, account: "acme-dev" });
  });

  it("a refused token is rejected with the host's own token page, a token without repository access is forbidden", async () => {
    const refused = fakeGitHosts({ "GET https://ghe.acme.test/api/v3/user": () => ({ status: 401 }) });
    const first = await checkGitToken(refused.fetch, "github", "ghe.acme.test", TOKEN);
    expect(first).toMatchObject({ ok: false, failure: { reason: "rejected", status: 401 } });
    expect(first.ok === false && first.failure.fixUrl).toContain(
      "https://ghe.acme.test/settings/personal-access-tokens/new",
    );
    const noRepos = fakeGitHosts({
      "GET https://api.github.com/user": () => ok({ login: "acme-dev" }),
      "GET https://api.github.com/user/repos": () => ({ status: 403 }),
    });
    expect(await checkGitToken(noRepos.fetch, "github", "github.com", TOKEN)).toMatchObject({
      ok: false,
      failure: { reason: "forbidden", status: 403 },
    });
  });

  it("GitLab self-managed: the host's own /api/v4, a project list as the second call", async () => {
    const hosts = fakeGitHosts({
      "GET https://git.acme.test/api/v4/user": () => ok({ username: "acme-dev" }),
      "GET https://git.acme.test/api/v4/projects": () => ok([]),
    });
    expect(await checkGitToken(hosts.fetch, "gitlab", "git.acme.test", TOKEN)).toMatchObject({
      ok: true,
      account: "acme-dev",
      checked: ["Asked git.acme.test who the token belongs to", "Listed one project"],
    });
  });

  it("Bitbucket Cloud: email and API token as Basic, the account is the nickname", async () => {
    const hosts = fakeGitHosts({
      "GET https://api.bitbucket.org/2.0/user": (req) =>
        req.headers.authorization === `Basic ${Buffer.from(`dev@acme.test:${TOKEN}`).toString("base64")}`
          ? ok({ nickname: "acme-dev", display_name: "Acme Dev" })
          : { status: 401 },
      "GET https://api.bitbucket.org/2.0/repositories": () => ok({ values: [] }),
    });
    expect(
      await checkGitToken(hosts.fetch, "bitbucket", "bitbucket.org", `dev@acme.test:${TOKEN}`),
    ).toMatchObject({
      ok: true,
      account: "acme-dev",
    });
  });

  it("Bitbucket Server: an HTTP access token as Bearer; the user is named in a header, and nobody is a refusal", async () => {
    const good = fakeGitHosts({
      "GET https://bb.acme.test/plugins/servlet/applinks/whoami": (req) =>
        bearer(req) ? { headers: { "x-ausername": "acme-dev" } } : { headers: {} },
      "GET https://bb.acme.test/rest/api/1.0/repos": () => ok({ values: [] }),
    });
    expect(await checkGitToken(good.fetch, "bitbucket", "bb.acme.test", TOKEN)).toMatchObject({
      ok: true,
      account: "acme-dev",
    });
    // Bitbucket Server answers an unknown token with 200 and no user.
    const nobody = await checkGitToken(good.fetch, "bitbucket", "bb.acme.test", "not-the-token-0000");
    expect(nobody).toMatchObject({ ok: false, failure: { reason: "rejected", status: 200 } });
  });

  it("a 200 that is not the host's API is unexpected, never a pass", async () => {
    const hosts = fakeGitHosts({ "GET https://api.github.com/user": () => ok({ html: "log in" }) });
    expect(await checkGitToken(hosts.fetch, "github", "github.com", TOKEN)).toMatchObject({
      ok: false,
      failure: { reason: "unexpected" },
    });
  });

  it("a host that does not exist is not-found, one that is down is service-down, a refused connection is unreachable", async () => {
    const notFound = fakeGitHosts({});
    expect(await checkGitToken(notFound.fetch, "github", "ghe.acme.test", TOKEN)).toMatchObject({
      failure: { reason: "not-found", status: 404 },
    });
    const down = fakeGitHosts({ "GET https://api.github.com/user": () => ({ status: 502 }) });
    expect(await checkGitToken(down.fetch, "github", "github.com", TOKEN)).toMatchObject({
      failure: { reason: "service-down" },
    });
    const refused = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    expect(await checkGitToken(refused, "github", "github.com", TOKEN)).toMatchObject({
      failure: { reason: "unreachable" },
    });
  });

  it("never follows a redirect with the token", async () => {
    const seen: (string | undefined)[] = [];
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.redirect);
      return new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } });
    }) as unknown as typeof fetch;
    expect(await checkGitToken(fetchFn, "github", "github.com", TOKEN)).toMatchObject({
      ok: false,
      failure: { reason: "unexpected", status: 302 },
    });
    expect(seen).toEqual(["manual"]);
  });
});

describe("a self-hosted host: signing in validates the address first", () => {
  function service(lookup: (name: string) => Promise<string[]>) {
    const hosts = fakeGitHosts({
      "GET https://ghe.acme.test/api/v3/user": () => ok({ login: "acme-dev" }),
      "GET https://10.2.3.4/api/v3/user": () => ok({ login: "acme-dev" }),
    });
    const orgs: Record<string, OrgConfig> = { acme: { name: "Acme" } };
    const saved = new Map<string, string>();
    const events: SignInStatus[] = [];
    const sign = new SignInService({
      fetch: hosts.fetch,
      apps: async () => ({ gitlab: {} }),
      readSecret: async (name) => saved.get(name),
      openUrl: async () => false,
      orgs: async () => structuredClone(orgs),
      saveSecret: async ({ value }) => {
        const ref = `s${saved.size + 1}`;
        saved.set(ref, value);
        return { ref: `secret:${ref}` };
      },
      dropSecret: async () => undefined,
      publicProfile: async () => undefined,
      writeOrg: async (id, patch) => {
        const org = orgs[id];
        if (org === undefined) throw new UserError("no org");
        if (patch.git_accounts !== null) org.git_accounts = patch.git_accounts;
      },
      changed: (status) => events.push(status),
      checkHost: (host, o) => assertHostAllowed(host, { allowPrivate: o.allowPrivate, lookup }),
    });
    return { sign, hosts, saved, orgs };
  }

  it("GitHub Enterprise on a public host signs in with a pasted token, and nothing is sent to github.com", async () => {
    const s = service(async () => ["203.0.114.9"]);
    const status = await s.sign.token(
      { org: "acme", kind: "github", host: "ghe.acme.test", token: TOKEN },
      OWNER,
    );
    expect(status).toMatchObject({ state: "done", account: "acme-dev", host: "ghe.acme.test" });
    expect(s.hosts.requests.map((r) => new URL(r.url).host)).toEqual(["ghe.acme.test"]);
    expect(s.orgs.acme?.git_accounts?.[0]).toMatchObject({ host: "ghe.acme.test", account: "acme-dev" });
  });

  it("a host that resolves to a private address is refused unless the owner confirms it, and nothing is sent before", async () => {
    const s = service(async () => ["10.2.3.4"]);
    await expect(
      s.sign.token({ org: "acme", kind: "github", host: "ghe.acme.test", token: TOKEN }, OWNER),
    ).rejects.toThrow(/private network/);
    expect(s.hosts.requests).toEqual([]);
    expect(s.saved.size).toBe(0);
    const confirmed = await s.sign.token(
      { org: "acme", kind: "github", host: "ghe.acme.test", token: TOKEN, allowPrivate: true },
      OWNER,
    );
    expect(confirmed.state).toBe("done");
  });

  it("a private address typed as the host is refused the same way, and a metadata address never passes", async () => {
    const s = service(async () => {
      throw new Error("must not look up an address");
    });
    await expect(
      s.sign.token({ org: "acme", kind: "github", host: "10.2.3.4", token: TOKEN }, OWNER),
    ).rejects.toThrow(/private network/);
    await expect(
      s.sign.token(
        { org: "acme", kind: "github", host: "169.254.169.254", token: TOKEN, allowPrivate: true },
        OWNER,
      ),
    ).rejects.toThrow(/metadata/);
    expect(s.hosts.requests).toEqual([]);
  });

  it("the public host is never looked up or blocked", async () => {
    const s = service(async () => {
      throw new Error("no lookup for the public host");
    });
    s.hosts.on("GET https://api.github.com/user", () => ok({ login: "acme-dev" }));
    const status = await s.sign.token({ org: "acme", kind: "github", token: TOKEN }, OWNER);
    expect(status.state).toBe("done");
  });

  it("a wrong token on a self-hosted host fails with a typed rejected, and saves nothing", async () => {
    const s = service(async () => ["203.0.114.9"]);
    s.hosts.on("GET https://ghe.acme.test/api/v3/user", () => ({ status: 401 }));
    const status = await s.sign.token(
      { org: "acme", kind: "github", host: "ghe.acme.test", token: TOKEN },
      OWNER,
    );
    expect(status).toMatchObject({ state: "failed", failure: { reason: "rejected" } });
    expect(s.orgs.acme?.git_accounts).toBeUndefined();
  });
});
