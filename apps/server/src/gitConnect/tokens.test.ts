import type { OrgConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { fakeGitHosts } from "../testing/gitHosts.ts";
import { TokenRefused } from "./http.ts";
import { GitTokens, tokenAuth } from "./tokens.ts";

const NOW = Date.parse("2026-10-02T10:00:00Z");

function setup(expiresAt: string) {
  const hosts = fakeGitHosts();
  const secrets = new Map<string, string>([
    ["acme-token", "glpat_old_access"],
    [
      "acme-grant",
      JSON.stringify({
        v: 1,
        kind: "gitlab",
        host: "gitlab.com",
        clientId: "0123456789abcdef",
        refreshToken: "refresh-1",
        expiresAt,
      }),
    ],
    ["globex-token", "glpat_globex"],
  ]);
  const orgs: Record<string, OrgConfig> = {
    acme: {
      name: "Acme",
      git_accounts: [
        { host: "gitlab.com", account: "acme-dev", token: "secret:acme-token", oauth: "secret:acme-grant" },
      ],
      mr_tokens: { gitlab: "secret:acme-token" },
    },
    globex: { name: "Globex", mr_tokens: { gitlab: "secret:globex-token" } },
  };
  let n = 1;
  hosts.on("POST https://gitlab.com/oauth/token", (req) => {
    if (req.form.refresh_token !== `refresh-${n}`) return { status: 400, json: { error: "invalid_grant" } };
    n += 1;
    return { json: { access_token: `glpat_new_${n}`, refresh_token: `refresh-${n}`, expires_in: 7200 } };
  });
  const tokens = new GitTokens({
    orgs: async () => orgs,
    secrets: { get: async (k) => secrets.get(k), set: async (k, v) => void secrets.set(k, v) },
    fetch: hosts.fetch,
    now: () => NOW,
  });
  return { hosts, secrets, tokens, orgs };
}

describe("GitTokens", () => {
  it("uses a token with time left as it is", async () => {
    const s = setup("2026-10-02T11:00:00Z");
    expect(await s.tokens.value("secret:acme-token")).toBe("glpat_old_access");
    expect(s.hosts.requests).toEqual([]);
  });

  it("refreshes within ten minutes of expiry, rewrites both secrets in place and keeps the rotated refresh token", async () => {
    const s = setup("2026-10-02T10:09:00Z");
    expect(await s.tokens.value("secret:acme-token")).toBe("glpat_new_2");
    expect(s.hosts.requests[0]?.form).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "0123456789abcdef",
    });
    expect(s.secrets.get("acme-token")).toBe("glpat_new_2");
    expect(JSON.parse(s.secrets.get("acme-grant") ?? "")).toMatchObject({
      refreshToken: "refresh-2",
      expiresAt: "2026-10-02T12:00:00.000Z",
    });
    // The second refresh must use the rotated token, which works.
    expect(await s.tokens.value("secret:acme-token", { force: true })).toBe("glpat_new_3");
  });

  it("refreshes once when two reads race", async () => {
    const s = setup("2026-10-02T10:01:00Z");
    const [a, b] = await Promise.all([
      s.tokens.value("secret:acme-token"),
      s.tokens.value("secret:acme-token"),
    ]);
    expect([a, b]).toEqual(["glpat_new_2", "glpat_new_2"]);
    expect(s.hosts.requests).toHaveLength(1);
  });

  it("retries once after a refresh when the host refuses a signed-in token", async () => {
    const s = setup("2026-10-02T11:00:00Z");
    const seen: string[] = [];
    const out = await s.tokens.withToken("acme", "gitlab", "gitlab.com", async (token) => {
      seen.push(token);
      if (token === "glpat_old_access") throw new TokenRefused("refused");
      return "listed";
    });
    expect(out).toEqual({ state: "ok", value: "listed", account: "acme-dev" });
    expect(seen).toEqual(["glpat_old_access", "glpat_new_2"]);
  });

  it("answers refused when the refresh token is no longer good, and signed-out with no token", async () => {
    const s = setup("2026-10-02T10:00:00Z");
    s.secrets.set(
      "acme-grant",
      JSON.stringify({ ...JSON.parse(s.secrets.get("acme-grant") ?? ""), refreshToken: "stale" }),
    );
    expect(await s.tokens.withToken("acme", "gitlab", "gitlab.com", async () => "x")).toEqual({
      state: "refused",
      account: "acme-dev",
    });
    expect(await s.tokens.withToken("acme", "github", "github.com", async () => "x")).toEqual({
      state: "signed-out",
    });
  });

  it("never refreshes a pasted token, and reads only the named workspace's token", async () => {
    const s = setup("2026-10-02T10:00:00Z");
    const seen: string[] = [];
    const out = await s.tokens.withToken("globex", "gitlab", "gitlab.com", async (token) => {
      seen.push(token);
      throw new TokenRefused("no");
    });
    expect(out).toEqual({ state: "refused", account: "" });
    expect(seen).toEqual(["glpat_globex"]);
    expect(s.hosts.requests).toEqual([]);
  });
});

describe("tokenAuth", () => {
  it("uses each host's git user name and keeps the token out of the user name", () => {
    expect(tokenAuth("github", "gho_x")).toEqual({
      kind: "token",
      username: "x-access-token",
      password: "gho_x",
    });
    expect(tokenAuth("gitlab", "glpat_x")).toEqual({
      kind: "token",
      username: "oauth2",
      password: "glpat_x",
    });
    expect(tokenAuth("bitbucket", "bb_oauth")).toEqual({
      kind: "token",
      username: "x-token-auth",
      password: "bb_oauth",
    });
    expect(tokenAuth("bitbucket", "owner@acme.test:ATATT123")).toEqual({
      kind: "token",
      username: "x-bitbucket-api-token-auth",
      password: "ATATT123",
    });
  });
});
