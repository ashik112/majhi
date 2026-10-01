import { type GitAccount, OrgConfigSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type GitAccountDeps, identityToFill, setGitAccount } from "./gitAccount.ts";

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
          git_accounts: [{ host: "gitlab.com", account: "acme-dev", ssh: "gl-acme", token: "secret:acme-gitlab" }],
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

  it("refuses an unknown org and validates nothing is written", async () => {
    const { deps, writes } = setup();
    await expect(setGitAccount(deps, { id: "nope", host: "gitlab.com", account: "a" })).rejects.toThrow(/does not exist/);
    expect(writes).toEqual([]);
  });
});

describe("git_accounts config", () => {
  it("validates and keeps entries as written", () => {
    const org = { name: "Acme", git_accounts: [{ host: "gitlab.com", account: "acme-dev", ssh: "gl-acme" }] };
    expect(OrgConfigSchema.parse(org).git_accounts).toEqual(org.git_accounts);
    expect(OrgConfigSchema.safeParse({ name: "Acme", git_accounts: [{ host: "", account: "a" }] }).success).toBe(false);
    expect(OrgConfigSchema.safeParse({ name: "Acme", git_accounts: [{ host: "x.com", account: "a", extra: 1 }] }).success).toBe(false);
  });
});
