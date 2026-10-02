import { describe, expect, it } from "vitest";
import { chooseRoute, httpsPushUrl, httpsToSsh, ownerOf } from "./route.ts";

describe("httpsToSsh", () => {
  it("builds the SSH address for each host, keeping subgroups", () => {
    expect(httpsToSsh("https://github.com/acme/api.git")).toBe("git@github.com:acme/api.git");
    expect(httpsToSsh("https://github.com/acme/api")).toBe("git@github.com:acme/api.git");
    expect(httpsToSsh("https://gitlab.com/globex/platform/tools/api.git", "gl-globex")).toBe(
      "git@gl-globex:globex/platform/tools/api.git",
    );
    expect(httpsToSsh("https://user@bitbucket.org/northwind/api.git")).toBe(
      "git@bitbucket.org:northwind/api.git",
    );
  });

  it("leaves other addresses alone", () => {
    expect(httpsToSsh("git@github.com:acme/api.git")).toBe("git@github.com:acme/api.git");
    expect(httpsToSsh("/Users/owner/api")).toBe("/Users/owner/api");
  });
});

describe("ownerOf", () => {
  it("is the namespace of the repo", () => {
    expect(ownerOf("https://gitlab.com/globex/platform/api.git")).toBe("globex/platform");
  });
});

describe("chooseRoute", () => {
  const acme = { via: "ssh", account: "acme-dev" } as const;
  const globex = { via: "ssh", alias: "gh-globex", account: "globex" } as const;
  const cli = { via: "gh", account: "acme-dev" } as const;

  it("takes the only key, and ignores CLI logins", () => {
    expect(chooseRoute({ explicit: undefined, owner: "acme", logins: [cli, acme] })).toEqual({
      state: "auto",
      account: "acme-dev",
    });
  });

  it("finds nothing without a key", () => {
    expect(chooseRoute({ explicit: undefined, owner: "acme", logins: [cli] })).toEqual({ state: "none" });
  });

  it("prefers the account that owns the namespace, else asks", () => {
    expect(chooseRoute({ explicit: undefined, owner: "globex", logins: [acme, globex] })).toEqual({
      state: "auto",
      account: "globex",
      alias: "gh-globex",
    });
    expect(chooseRoute({ explicit: undefined, owner: "northwind", logins: [acme, globex] })).toEqual({
      state: "ambiguous",
      choices: [acme, globex],
    });
  });

  it("always keeps the owner's pick", () => {
    expect(chooseRoute({ explicit: "my-alias", owner: "acme", logins: [acme] })).toEqual({
      state: "picked",
      alias: "my-alias",
    });
  });
});

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

  it("a project's explicit alias wins over the org", () => {
    expect(
      chooseRoute({ explicit: "mine", org: { account: "acme-dev" }, owner: "acme", logins: [acme] }),
    ).toEqual({
      state: "picked",
      alias: "mine",
    });
  });

  it("refuses with the account's name when no key logs in as it, or the named route is absent", () => {
    expect(
      chooseRoute({ explicit: undefined, org: { account: "globex-dev" }, owner: "x", logins: [acme] }),
    ).toEqual({
      state: "org-missing",
      account: "globex-dev",
    });
    expect(
      chooseRoute({
        explicit: undefined,
        org: { account: "globex-dev", ssh: "default" },
        owner: "x",
        logins: [globex],
      }),
    ).toEqual({ state: "org-missing", account: "globex-dev" });
  });

  it("an org route saved as the host name pushes over the host's default key", () => {
    const logins = [
      { via: "ssh" as const, alias: "gl-other", account: "sample-user" },
      { via: "ssh" as const, account: "sample-user" },
    ];
    expect(
      chooseRoute({
        host: "gitlab.com",
        explicit: undefined,
        org: { account: "sample-user", ssh: "gitlab.com" },
        owner: "acme",
        logins,
      }),
    ).toEqual({ state: "auto", account: "sample-user" });
  });

  it("an org without a binding ignores other orgs' accounts", () => {
    expect(chooseRoute({ explicit: undefined, org: undefined, owner: "acme", logins: [acme] })).toEqual({
      state: "auto",
      account: "acme-dev",
    });
  });
});

describe("https route through the Mac", () => {
  const acme = { via: "ssh", account: "acme-dev" } as const;

  it("is used for the org's account when no key logs in as it", () => {
    expect(
      chooseRoute({
        explicit: undefined,
        org: { account: "globex-dev" },
        owner: "x",
        logins: [acme],
        httpsOk: true,
      }),
    ).toEqual({
      state: "https",
      account: "globex-dev",
    });
  });

  it("prefers the org account's SSH route, an explicit alias, and an automatic key over https", () => {
    expect(
      chooseRoute({
        explicit: undefined,
        org: { account: "acme-dev" },
        owner: "x",
        logins: [acme],
        httpsOk: true,
      }).state,
    ).toBe("auto");
    expect(
      chooseRoute({ explicit: "mine", org: { account: "zed" }, owner: "x", logins: [], httpsOk: true }),
    ).toEqual({
      state: "picked",
      alias: "mine",
    });
    expect(
      chooseRoute({ explicit: undefined, org: undefined, owner: "acme", logins: [acme], httpsOk: true })
        .state,
    ).toBe("auto");
  });

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

describe("httpsPushUrl", () => {
  it("sets the account as the user and drops any password", () => {
    expect(httpsPushUrl("https://github.com/acme/api.git", "acme-dev")).toBe(
      "https://acme-dev@github.com/acme/api.git",
    );
    expect(httpsPushUrl("https://old:pw@github.com/acme/api.git", "acme-dev")).toBe(
      "https://acme-dev@github.com/acme/api.git",
    );
    expect(httpsPushUrl("https://github.com/acme/api.git")).toBe("https://github.com/acme/api.git");
    expect(httpsPushUrl("git@github.com:acme/api.git", "acme-dev")).toBe("git@github.com:acme/api.git");
  });
});
