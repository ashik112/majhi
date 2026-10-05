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

  it("a 200 that is not the host's API is unexpected, never a pass", async () => {
    const hosts = fakeGitHosts({ "GET https://api.github.com/user": () => ok({ html: "log in" }) });
    expect(await checkGitToken(hosts.fetch, "github", "github.com", TOKEN)).toMatchObject({
      ok: false,
      failure: { reason: "unexpected" },
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
});
