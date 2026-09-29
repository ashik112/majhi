import type { Repo, RootScan } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { filterRoots, highlightParts, primaryRemote, searchTerms } from "./filter";

function repo(name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    name,
    path: `/home/me/Work/${name}`,
    relPath: name,
    branch: "main",
    remotes: [],
    registered: false,
    ...overrides,
  };
}

const api = repo("alpha-api", {
  remotes: [{ name: "origin", url: "git@github.com:acme/alpha-api.git", host: "github" }],
});
const web = repo("beta-web", {
  relPath: "clients/beta-web",
  path: "/home/me/Work/clients/beta-web",
  branch: "develop",
  remotes: [{ name: "origin", url: "git@gitlab.com:acme/beta-web.git", host: "gitlab" }],
});
const infra = repo("gamma-infra", {
  remotes: [
    { name: "backup", url: "git@github.com:acme/gamma-infra.git", host: "github" },
    {
      name: "origin",
      url: "git@bitbucket-acme:acme/gamma-infra.git",
      host: "bitbucket",
      sshAlias: "bitbucket-acme",
    },
  ],
});

const roots: RootScan[] = [
  { path: "/home/me/Work", mounted: true, repos: [api, web, infra] },
  { path: "/home/me/empty", mounted: true, repos: [] },
  { path: "/home/me/missing", mounted: false, repos: [] },
];

const names = (result: RootScan[]) => result.flatMap((root) => root.repos.map((r) => r.name));

describe("filterRoots", () => {
  it("returns every root, empty and unmounted ones included, when there is no query", () => {
    expect(filterRoots(roots, searchTerms("   ")).map((root) => root.path)).toEqual(roots.map((r) => r.path));
  });

  it("matches the host label, remote URL, branch and SSH alias, ignoring case", () => {
    expect(names(filterRoots(roots, searchTerms("GitLab")))).toEqual(["beta-web"]);
    expect(names(filterRoots(roots, searchTerms("acme/alpha")))).toEqual(["alpha-api"]);
    expect(names(filterRoots(roots, searchTerms("develop")))).toEqual(["beta-web"]);
    expect(names(filterRoots(roots, searchTerms("bitbucket-acme")))).toEqual(["gamma-infra"]);
  });

  it("searches every remote, not only the one the row shows", () => {
    expect(names(filterRoots(roots, searchTerms("github")))).toEqual(["alpha-api", "gamma-infra"]);
  });

  it("requires every term to match", () => {
    expect(names(filterRoots(roots, searchTerms("clients web")))).toEqual(["beta-web"]);
    expect(names(filterRoots(roots, searchTerms("clients api")))).toEqual([]);
  });

  it("drops roots without a match while searching", () => {
    expect(filterRoots(roots, searchTerms("alpha")).map((root) => root.path)).toEqual(["/home/me/Work"]);
  });
});

describe("primaryRemote", () => {
  it("prefers origin over the first remote", () => {
    expect(primaryRemote(infra)?.host).toBe("bitbucket");
  });

  it("falls back to the first remote, or nothing", () => {
    const upstreamOnly = repo("x", { remotes: [{ name: "upstream", url: "u", host: "other" }] });
    expect(primaryRemote(upstreamOnly)?.name).toBe("upstream");
    expect(primaryRemote(repo("y"))).toBeUndefined();
  });
});

describe("highlightParts", () => {
  it("marks every occurrence, case-insensitively, and keeps the original casing", () => {
    expect(highlightParts("Api-api", ["api"])).toEqual([
      { text: "Api", match: true },
      { text: "-", match: false },
      { text: "api", match: true },
    ]);
  });

  it("merges overlapping terms into one marked run", () => {
    expect(highlightParts("alpha-api", ["alph", "pha-a"])).toEqual([
      { text: "alpha-a", match: true },
      { text: "pi", match: false },
    ]);
  });

  it("returns the text unmarked when nothing matches", () => {
    expect(highlightParts("beta", ["zzz"])).toEqual([{ text: "beta", match: false }]);
  });
});
