import type { GitAccount } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchProbe,
  type GitAccountDeps,
  identityToFill,
  type SavedLoginDeps,
  setGitAccount,
  useSavedLogin,
} from "./gitAccount.ts";

describe("git accounts", () => {
  const setup = (identity?: { name: string; email: string }) => {
    const orgs: Record<string, { identity?: { name: string; email: string }; accounts: GitAccount[] }> = {
      acme: { ...(identity ? { identity } : {}), accounts: [] },
      globex: { accounts: [] },
    };
    const writes: Array<{ id: string; patch: unknown }> = [];
    const adopted: string[] = [];
    const deps: GitAccountDeps = {
      org: async (id) => orgs[id],
      logins: async () => [{ host: "gitlab.com", logins: [{ via: "glab", account: "acme-dev" }] }],
      adopt: async (via, host) => {
        adopted.push(`${via}:${host}`);
        return "secret:acme-gitlab";
      },
      saveSecret: async () => ({ ref: "secret:pasted" }),
      publicProfile: async () => ({ name: "Acme Dev", email: "dev@acme.example" }),
      probe: async () => {
        throw new Error("no network in tests");
      },
      classify: () => "gitlab",
      write: async (id, patch) => {
        writes.push({ id, patch });
      },
    };
    return { deps, writes, adopted };
  };

  it("adopts the matching login's token and writes only to the chosen org", async () => {
    const { deps, writes, adopted } = setup();
    await setGitAccount(deps, { id: "acme", host: "GitLab.com", account: "acme-dev", ssh: "gl-acme" });
    expect(adopted).toEqual(["glab:gitlab.com"]);
    expect(writes).toEqual([
      {
        id: "acme",
        patch: {
          git_accounts: [
            { host: "gitlab.com", account: "acme-dev", ssh: "gl-acme", token: "secret:acme-gitlab" },
          ],
          identity: { name: "Acme Dev", email: "dev@acme.example" },
        },
      },
    ]);
  });

  it("never overwrites an identity the owner set", async () => {
    const owner = { name: "Owner", email: "owner@acme.example" };
    const { deps, writes } = setup(owner);
    await setGitAccount(deps, { id: "acme", host: "gitlab.com", account: "acme-dev" });
    expect(JSON.stringify(writes[0]?.patch)).not.toContain("identity");
    expect(identityToFill(owner, { name: "X", email: "x@y.example" })).toBeUndefined();
  });
});

describe("useSavedLogin", () => {
  const setup = (status: number, secret: string | Error = "tok123") => {
    const orgs: Record<string, GitAccount[]> = {
      acme: [{ host: "github.com", account: "acme-dev" }],
      globex: [{ host: "github.com", account: "globex-dev" }],
    };
    const writes: Array<{ id: string; patch: { git_accounts: GitAccount[]; mr_token: unknown } }> = [];
    const saved: string[] = [];
    const probes: Array<{ url: string; auth: string | undefined }> = [];
    const deps: SavedLoginDeps = {
      org: async (id) => (orgs[id] === undefined ? undefined : { accounts: orgs[id] }),
      readSecret: async () => {
        if (secret instanceof Error) throw secret;
        return secret;
      },
      probe: async (url, headers) => {
        probes.push({ url, auth: headers.authorization });
        return { status, body: status === 200 ? { login: "acme-dev" } : undefined };
      },
      saveSecret: async (s) => {
        saved.push(s.label);
        return { ref: "secret:new" };
      },
      write: async (id, patch) => {
        writes.push({ id, patch });
      },
    };
    return { deps, writes, saved, probes };
  };
  const classify = () => "github" as const;

  it("saves for the chosen org only, after the API accepts it", async () => {
    const { deps, writes, probes } = setup(200);
    expect(
      await useSavedLogin(deps, classify, { id: "acme", host: "github.com", account: "acme-dev" }),
    ).toEqual({ saved: true });
    expect(probes).toEqual([{ url: "https://api.github.com/user", auth: "Bearer tok123" }]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.id).toBe("acme");
    expect(writes[0]?.patch.git_accounts).toEqual([
      { host: "github.com", account: "acme-dev", token: "secret:new" },
    ]);
  });

  it("saves nothing when the API refuses it, and the reason never holds the secret", async () => {
    const { deps, writes, saved } = setup(401);
    const out = await useSavedLogin(deps, classify, { id: "acme", host: "github.com", account: "acme-dev" });
    expect(out.saved).toBe(false);
    expect(out.reason).not.toContain("tok123");
    expect(writes).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("saves nothing when this computer has no saved login, or the org has no such account", async () => {
    const none = setup(200, new Error("This computer has no saved login for acme-dev on github.com."));
    expect(
      (await useSavedLogin(none.deps, classify, { id: "acme", host: "github.com", account: "acme-dev" }))
        .saved,
    ).toBe(false);
    expect(none.writes).toEqual([]);
    const other = setup(200);
    await expect(
      useSavedLogin(other.deps, classify, { id: "acme", host: "github.com", account: "globex-dev" }),
    ).rejects.toThrow();
    expect(other.writes).toEqual([]);
  });
});

describe("a pasted token", () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = () => {
    const orgs: Record<string, { accounts: GitAccount[]; mrTokens?: Record<string, string> }> = {
      acme: { accounts: [{ host: "gitlab.com", account: "sample-user", ssh: "default" }] },
      globex: { accounts: [], mrTokens: { gitlab: "secret:globex" } },
    };
    const writes: Array<{ id: string; patch: unknown }> = [];
    const saved: string[] = [];
    const deps: GitAccountDeps = {
      org: async (id) => {
        const org = orgs[id];
        return org === undefined
          ? undefined
          : {
              identity: { name: "A", email: "a@acme.example" },
              accounts: org.accounts,
              mrTokens: org.mrTokens,
            };
      },
      logins: async () => [],
      adopt: async () => "secret:adopted",
      saveSecret: async (s) => {
        saved.push(s.label);
        return { ref: "secret:pasted" };
      },
      publicProfile: async () => undefined,
      probe: fetchProbe,
      classify: () => "gitlab",
      write: async (id, patch) => {
        writes.push({ id, patch });
      },
    };
    const input = { id: "acme", host: "gitlab.com", account: "sample-user", token: "sample-token" };
    return { deps, writes, saved, input };
  };
  const answer = (status: number, body: unknown) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://gitlab.com/api/v4/user");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sample-token");
      return new Response(status === 200 ? JSON.stringify(body) : "{}", { status });
    });

  it("is saved for that org only, after the host says whose it is", async () => {
    const { deps, writes, saved, input } = setup();
    vi.stubGlobal("fetch", answer(200, { username: "sample-user" }));
    await setGitAccount(deps, input);
    expect(saved).toEqual(["acme gitlab.com sample-user token"]);
    expect(writes).toEqual([
      {
        id: "acme",
        patch: {
          git_accounts: [
            { host: "gitlab.com", account: "sample-user", ssh: "default", token: "secret:pasted" },
          ],
          mr_tokens: { gitlab: "secret:pasted" },
        },
      },
    ]);
  });

  it("is never saved when the host refuses it, or it belongs to someone else", async () => {
    for (const fetch of [answer(401, undefined), answer(200, { username: "someone-else" })]) {
      const { deps, writes, saved, input } = setup();
      vi.stubGlobal("fetch", fetch);
      const failure = await setGitAccount(deps, input).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("sample-token");
      expect(saved).toEqual([]);
      expect(writes).toEqual([]);
    }
  });

  it("is never saved when the host cannot be reached", async () => {
    const { deps, writes, saved, input } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(setGitAccount(deps, input)).rejects.toThrow();
    expect(saved).toEqual([]);
    expect(writes).toEqual([]);
  });
});
