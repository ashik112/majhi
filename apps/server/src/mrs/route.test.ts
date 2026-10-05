import { describe, expect, it } from "vitest";
import { chooseRoute } from "./route.ts";

describe("chooseRoute with an org git account", () => {
  const acme = { via: "ssh", account: "acme-dev" } as const;
  const globex = { via: "ssh", alias: "gh-globex", account: "globex-dev" } as const;

  it("the org's account wins over the automatic choice", () => {
    expect(
      chooseRoute({
        explicit: undefined,
        org: { account: "globex-dev" },
        owner: "acme",
        logins: [acme, globex],
      }),
    ).toEqual({
      state: "auto",
      account: "globex-dev",
      alias: "gh-globex",
    });
  });

  it("an org without a binding ignores other orgs' accounts", () => {
    expect(chooseRoute({ explicit: undefined, org: undefined, owner: "acme", logins: [acme] })).toEqual({
      state: "auto",
      account: "acme-dev",
    });
  });
});

describe("https route through the host helper", () => {
  it("falls back to https without an account when nothing else fits, and never borrows another org's", () => {
    expect(
      chooseRoute({ explicit: undefined, org: undefined, owner: "acme", logins: [], httpsOk: true }),
    ).toEqual({ state: "https" });
    expect(
      chooseRoute({ explicit: undefined, org: undefined, owner: "acme", logins: [], httpsOk: false }),
    ).toEqual({ state: "none" });
    expect(
      chooseRoute({
        explicit: undefined,
        org: { account: "globex-dev" },
        owner: "x",
        logins: [],
        httpsOk: false,
      }),
    ).toEqual({
      state: "org-missing",
      account: "globex-dev",
    });
  });
});
