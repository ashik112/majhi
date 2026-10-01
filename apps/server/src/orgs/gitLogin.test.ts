import { GitLoginsResultSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type AdoptDeps, useGitLogin } from "./gitLogin.ts";

describe("useGitLogin", () => {
  const setup = () => {
    const secrets: Array<{ value: string; label: string }> = [];
    const orgTokens: Record<string, Partial<Record<"github" | "gitlab" | "bitbucket", string>>> = {
      acme: { gitlab: "secret:acme-gitlab" },
      globex: {},
    };
    const deps: AdoptDeps = {
      readToken: async () => "tok-sample",
      saveSecret: async (s) => {
        secrets.push(s);
        return { ref: "secret:acme-github-token" };
      },
      orgTokens: async (org) => orgTokens[org],
      setOrgTokens: async (org, tokens) => {
        orgTokens[org] = tokens;
      },
    };
    return { deps, secrets, orgTokens };
  };

  it("saves the token for the chosen org only and returns no token", async () => {
    const { deps, secrets, orgTokens } = setup();
    const out = await useGitLogin(deps, { id: "acme", via: "gh", host: "github.com" });
    expect(out).toEqual({ id: "acme", host: "github", ref: "secret:acme-github-token" });
    expect(JSON.stringify(out)).not.toContain("tok-sample");
    expect(secrets).toEqual([{ value: "tok-sample", label: "acme github token" }]);
    expect(orgTokens.acme).toEqual({ gitlab: "secret:acme-gitlab", github: "secret:acme-github-token" });
    expect(orgTokens.globex).toEqual({});
  });

  it("refuses an unknown org without reading the token, and a mismatched tool", async () => {
    const { deps } = setup();
    let read = false;
    deps.readToken = async () => {
      read = true;
      return "tok-sample";
    };
    await expect(useGitLogin(deps, { id: "nope", via: "gh", host: "github.com" })).rejects.toThrow(
      "does not exist",
    );
    await expect(useGitLogin(deps, { id: "acme", via: "glab", host: "github.com" })).rejects.toThrow(
      "cannot be used",
    );
    expect(read).toBe(false);
  });
});

describe("git.logins result", () => {
  it("has no field that could hold a token", () => {
    const parsed = GitLoginsResultSchema.parse({
      hosts: [{ host: "github.com", logins: [{ via: "gh", account: "acme-dev", token: "tok-sample" }] }],
    });
    expect(JSON.stringify(parsed)).not.toContain("tok-sample");
  });
});
