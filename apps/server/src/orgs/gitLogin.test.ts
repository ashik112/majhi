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

  it("refuses an unknown org without reading the token, and a mismatched tool", async () => {
    const { deps } = setup();
    let read = false;
    deps.readToken = async () => {
      read = true;
      return "tok-sample";
    };
    await expect(useGitLogin(deps, { id: "nope", via: "gh", host: "github.com" })).rejects.toThrow();
    await expect(useGitLogin(deps, { id: "acme", via: "glab", host: "github.com" })).rejects.toThrow();
    expect(read).toBe(false);
  });
});
