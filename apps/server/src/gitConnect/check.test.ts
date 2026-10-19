import { describe, expect, it } from "vitest";
import { type FakeAnswer, fakeGitHosts } from "../testing/gitHosts.ts";
import { checkGitToken } from "./check.ts";

const TOKEN = "ghp_SecretAcmeToken0123456789";

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
});
