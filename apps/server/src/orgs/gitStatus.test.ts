import { type GitHostLogins, OrgConfigSchema } from "@majhi/shared";
import { describe, expect, it, vi } from "vitest";
import { classifyHost } from "../scan/remote.ts";
import { type GitStatusDeps, gitStatus, offersFor } from "./gitStatus.ts";

const LOGINS: GitHostLogins[] = [
  { host: "gitlab.com", logins: [{ via: "ssh", account: "sample-user" }] },
  {
    host: "github.com",
    logins: [
      { via: "gh", account: "acme-dev" },
      { via: "ssh", account: "acme-dev" },
    ],
  },
  { host: "bitbucket.org", logins: [{ via: "ssh", alias: "bitbucket-acme", account: "acme-dev" }] },
];

const setup = (over: Partial<GitStatusDeps> = {}, used = ["gitlab.com"], dismissed = [] as never[]) => {
  // As read from majhi.yaml: the route picker saved the host name.
  const config = OrgConfigSchema.parse({
    name: "Acme",
    git_accounts: [{ host: "gitlab.com", account: "sample-user", ssh: "gitlab.com" }],
    dismissed_logins: dismissed,
  });
  const deps: GitStatusDeps = {
    org: async (id) =>
      id === "acme"
        ? { accounts: config.git_accounts ?? [], mrTokens: {}, dismissed: config.dismissed_logins ?? [] }
        : undefined,
    usedHosts: async () => used,
    logins: async () => ({ hosts: LOGINS, checkedAt: "2026-01-01T00:00:00.000Z" }),
    checkToken: async () => ({ state: "ok", as: "sample-user" }),
    savedLogin: async () => "none",
    classify: classifyHost,
    ...over,
  };
  return deps;
};

describe("org git status", () => {
  it("shows the account saved with ssh: gitlab.com as pushing with the default key", async () => {
    const out = await gitStatus(setup(), "acme");
    expect(out.accounts).toEqual([
      {
        host: "gitlab.com",
        account: "sample-user",
        kind: "gitlab",
        push: { state: "ssh" },
        token: { state: "missing", savedLogin: false },
      },
    ]);
  });

  it("offers logins only for hosts the org's projects use", async () => {
    expect((await gitStatus(setup(), "acme")).missing).toEqual([]);
    const out = await gitStatus(setup({}, ["gitlab.com", "github.com"]), "acme");
    expect(out.missing).toEqual([
      {
        host: "github.com",
        kind: "github",
        offers: [{ account: "acme-dev", via: ["gh", "ssh"], ssh: "default" }],
      },
    ]);
  });

  it("does not offer a login the owner said No to for this org", async () => {
    const out = await gitStatus(
      setup({}, ["github.com"], [{ host: "github.com", account: "ACME-dev" }] as never[]),
      "acme",
    );
    expect(out.missing).toEqual([{ host: "github.com", kind: "github", offers: [] }]);
    expect(
      offersFor("github.com", LOGINS[1]?.logins ?? [], [{ host: "gitlab.com", account: "acme-dev" }]),
    ).toHaveLength(1);
  });

  it("never turns a failed saved-login check into an error", async () => {
    const savedLogin = vi.fn(async () => {
      throw new Error("This Mac has no saved login for sample-user on gitlab.com.");
    });
    const out = await gitStatus(setup({ savedLogin }), "acme");
    expect(savedLogin).toHaveBeenCalledOnce();
    expect(out.accounts[0]?.token).toEqual({ state: "missing", savedLogin: false });
    expect(JSON.stringify(out)).not.toContain("no saved login");
  });

  it("offers the saved login only when the host takes it as a token", async () => {
    const out = await gitStatus(setup({ savedLogin: async () => "token" }), "acme");
    expect(out.accounts[0]?.token).toEqual({ state: "missing", savedLogin: true });
  });

  it("reads an older org-wide token as the account's, and checks it", async () => {
    const checkToken = vi.fn(async () => ({ state: "ok" as const, as: "sample-user" }));
    const base = setup({ checkToken });
    const out = await gitStatus(
      {
        ...base,
        org: async (id) => {
          const org = await base.org(id);
          return org && { ...org, mrTokens: { gitlab: "secret:acme-gitlab" } };
        },
      },
      "acme",
    );
    expect(checkToken).toHaveBeenCalledWith("gitlab.com", "gitlab", "sample-user", "secret:acme-gitlab");
    expect(out.accounts[0]?.token).toEqual({ state: "ok", as: "sample-user" });
    expect(out.tokens).toEqual([]);
  });
});
