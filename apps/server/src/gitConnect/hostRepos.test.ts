import { describe, expect, it } from "vitest";
import { fakeGitHosts } from "../testing/gitHosts.ts";
import { createRepo, GITHUB_FILTER_PAGES, listRepos, nextFromLink } from "./hostRepos.ts";
import { TokenRefused } from "./http.ts";

const ghRepo = (owner: string, name: string) => ({
  full_name: `${owner}/${name}`,
  name,
  owner: { login: owner },
  description: null,
  private: true,
  default_branch: "main",
  pushed_at: "2026-09-30T10:00:00Z",
  archived: false,
  size: 10,
  html_url: `https://github.com/${owner}/${name}`,
  clone_url: `https://github.com/${owner}/${name}.git`,
  ssh_url: `git@github.com:${owner}/${name}.git`,
});

describe("GitHub repos", () => {
  it("reads one page of /user/repos with every affiliation and the next page from Link", async () => {
    const hosts = fakeGitHosts({
      "GET https://api.github.com/user/repos": () => ({
        json: [ghRepo("acme", "api"), { broken: true }],
        headers: {
          link: '<https://api.github.com/user/repos?page=3&per_page=2>; rel="next", <https://api.github.com/user/repos?page=9>; rel="last"',
        },
      }),
    });
    const page = await listRepos(hosts.fetch, "github", "gho_x", {
      host: "github.com",
      account: "octo",
      page: 2,
      perPage: 2,
    });
    expect(page.nextPage).toBe(3);
    expect(page.repos).toEqual([
      {
        fullName: "acme/api",
        name: "api",
        owner: "acme",
        private: true,
        defaultBranch: "main",
        updatedAt: "2026-09-30T10:00:00.000Z",
        archived: false,
        webUrl: "https://github.com/acme/api",
        httpsUrl: "https://github.com/acme/api.git",
        sshUrl: "git@github.com:acme/api.git",
      },
    ]);
    const url = new URL(hosts.requests[0]?.url ?? "");
    expect(url.searchParams.get("affiliation")).toBe("owner,collaborator,organization_member");
    expect(hosts.requests[0]?.headers.authorization).toBe("Bearer gho_x");
    expect(hosts.requests[0]?.url).not.toContain("gho_x");
  });

  it("filters by name over the pages it read, and pages the result itself", async () => {
    const all = Array.from({ length: 130 }, (_, i) => ghRepo(i % 2 === 0 ? "acme" : "globex", `svc-${i}`));
    const hosts = fakeGitHosts({
      "GET https://api.github.com/user/repos": (req) => {
        const page = Number(new URL(req.url).searchParams.get("page"));
        const slice = all.slice((page - 1) * 100, page * 100);
        return {
          json: slice,
          ...(page * 100 < all.length
            ? { headers: { link: `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"` } }
            : {}),
        };
      },
    });
    const first = await listRepos(hosts.fetch, "github", "t", {
      host: "github.com",
      account: "octo",
      query: "GLOBEX/svc-1",
      page: 1,
      perPage: 5,
    });
    expect(first.repos.map((r) => r.fullName)).toEqual([
      "globex/svc-1",
      "globex/svc-11",
      "globex/svc-13",
      "globex/svc-15",
      "globex/svc-17",
    ]);
    expect(first.nextPage).toBe(2);
    expect(hosts.requests.filter((r) => r.url.includes("/search/"))).toEqual([]);
  });

  it("uses the search API, limited to the account and its orgs, when the list is too long", async () => {
    const hosts = fakeGitHosts({
      "GET https://api.github.com/user/repos": (req) => {
        const page = Number(new URL(req.url).searchParams.get("page"));
        return {
          json: [ghRepo("acme", `r${page}`)],
          headers: { link: `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"` },
        };
      },
      "GET https://api.github.com/user/orgs": () => ({ json: [{ login: "acme" }] }),
      "GET https://api.github.com/search/repositories": () => ({
        json: { total_count: 1, items: [ghRepo("acme", "api")] },
      }),
    });
    const page = await listRepos(hosts.fetch, "github", "t", {
      host: "github.com",
      account: "octo",
      query: "api",
      page: 1,
      perPage: 30,
    });
    expect(page.repos.map((r) => r.fullName)).toEqual(["acme/api"]);
    expect(hosts.requests.filter((r) => r.url.includes("/user/repos"))).toHaveLength(GITHUB_FILTER_PAGES);
    const q = new URL(hosts.requests.at(-1)?.url ?? "").searchParams.get("q");
    expect(q).toBe("api in:name fork:true user:octo org:acme");
  });

  it("throws TokenRefused on 401", async () => {
    const hosts = fakeGitHosts({
      "GET https://api.github.com/user/repos": () => ({ status: 401, json: {} }),
    });
    await expect(
      listRepos(hosts.fetch, "github", "t", { host: "github.com", account: "o", page: 1, perPage: 30 }),
    ).rejects.toBeInstanceOf(TokenRefused);
  });

  it("reads rel=next only", () => {
    expect(nextFromLink(null)).toBeUndefined();
    expect(nextFromLink('<https://x/y?page=1>; rel="prev"')).toBeUndefined();
  });
});

describe("GitLab and Bitbucket repos", () => {
  it("GitLab pages with X-Next-Page and marks an empty repo", async () => {
    const hosts = fakeGitHosts({
      "GET https://gitlab.acme.test/api/v4/projects": () => ({
        json: [
          {
            id: 1,
            path_with_namespace: "group/sub/api",
            path: "api",
            namespace: { full_path: "group/sub" },
            visibility: "private",
            default_branch: "main",
            empty_repo: true,
            web_url: "https://gitlab.acme.test/group/sub/api",
            http_url_to_repo: "https://gitlab.acme.test/group/sub/api.git",
          },
        ],
        headers: { "x-next-page": "2" },
      }),
    });
    const page = await listRepos(hosts.fetch, "gitlab", "t", {
      host: "gitlab.acme.test",
      account: "dev",
      query: "api",
      page: 1,
      perPage: 20,
    });
    expect(page.nextPage).toBe(2);
    expect(page.repos[0]).toMatchObject({ fullName: "group/sub/api", owner: "group/sub", private: true });
    expect(page.repos[0]?.defaultBranch).toBeUndefined();
    expect(new URL(hosts.requests[0]?.url ?? "").searchParams.get("search")).toBe("api");
  });

  it("Bitbucket lists each workspace's repos and merges them by last update", async () => {
    const bb = (ws: string, slug: string, updated: string) => ({
      full_name: `${ws}/${slug}`,
      slug,
      workspace: { slug: ws },
      is_private: true,
      mainbranch: { name: "main" },
      updated_on: updated,
    });
    const hosts = fakeGitHosts({
      "GET https://api.bitbucket.org/2.0/user/workspaces": () => ({
        json: { values: [{ workspace: { slug: "acme" } }, { workspace: { slug: "globex" } }] },
      }),
      "GET https://api.bitbucket.org/2.0/repositories/acme": () => ({
        json: { values: [bb("acme", "old", "2026-01-01T00:00:00Z")] },
      }),
      "GET https://api.bitbucket.org/2.0/repositories/globex": () => ({
        json: {
          values: [bb("globex", "new", "2026-09-01T00:00:00Z")],
          next: "https://api.bitbucket.org/2.0/repositories/globex?page=2",
        },
      }),
    });
    const page = await listRepos(hosts.fetch, "bitbucket", "bb_oauth", {
      host: "bitbucket.org",
      account: "dev",
      page: 1,
      perPage: 10,
    });
    expect(page.repos.map((r) => r.fullName)).toEqual(["globex/new", "acme/old"]);
    expect(page.nextPage).toBe(2);
    expect(page.repos[0]?.httpsUrl).toBe("https://bitbucket.org/globex/new.git");
    expect(hosts.requests[0]?.headers.authorization).toBe("Bearer bb_oauth");
  });
});

describe("createRepo", () => {
  it("makes a private GitHub repo under the account or an organization", async () => {
    const hosts = fakeGitHosts({
      "POST https://api.github.com/user/repos": (req) => ({
        status: 201,
        json: ghRepo("octo", String((req.json as { name: string }).name)),
      }),
      "POST https://api.github.com/orgs/acme/repos": () => ({
        status: 422,
        json: { message: "name already exists on this account" },
      }),
    });
    const made = await createRepo(hosts.fetch, "github", "github.com", "t", "octo", {
      owner: "Octo",
      name: "demo",
      private: true,
    });
    expect(made.fullName).toBe("octo/demo");
    expect(hosts.requests[0]?.json).toEqual({ name: "demo", private: true, auto_init: false });
    await expect(
      createRepo(hosts.fetch, "github", "github.com", "t", "octo", {
        owner: "acme",
        name: "demo",
        private: true,
      }),
    ).rejects.toThrow("Creating acme/demo on GitHub was refused: name already exists on this account.");
  });
});
