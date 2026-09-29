import type { ProjectView } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  aliasClashes,
  groupByOrg,
  projectForPath,
  projectIdError,
  projectMatches,
  suggestProjectId,
} from "./project-model";

const api: ProjectView = { id: "api", org: "acme", path: "/w/api", aliases: ["backend"], exists: true };

describe("suggestProjectId", () => {
  it("makes an id from a folder name", () => {
    expect(suggestProjectId("Globex API")).toBe("globex-api");
    expect(suggestProjectId("__weird.name__")).toBe("weird-name");
  });
  it("avoids ids in use", () => {
    expect(suggestProjectId("api", ["api", "api-2"])).toBe("api-3");
  });
  it("gives nothing for a name with no usable characters", () => {
    expect(suggestProjectId("日本")).toBe("");
  });
});

describe("projectIdError", () => {
  it("accepts a good id and explains a bad one", () => {
    expect(projectIdError("api-2", [])).toBeUndefined();
    expect(projectIdError("", [])).toBe("Give the project an id");
    expect(projectIdError("Api", [])).toMatch(/lowercase/i);
    expect(projectIdError("api", ["api"])).toBe("Another project already uses this id");
  });
});

describe("aliasClashes", () => {
  it("finds aliases and ids other projects hold", () => {
    expect(aliasClashes(["backend", "svc", "api"], [api], "web")).toEqual([
      { alias: "backend", project: "api" },
      { alias: "api", project: "api" },
    ]);
    expect(aliasClashes(["backend"], [api], "api")).toEqual([]);
  });
});

describe("projectForPath", () => {
  it("matches by checkout path", () => {
    expect(projectForPath([api], "/w/api")?.id).toBe("api");
    expect(projectForPath([api], "/w/other")).toBeUndefined();
  });
});

describe("projectMatches", () => {
  const project = { id: "alpha-api", org: "acme", path: "/h/Work/alpha-api", aliases: ["backend"] };
  it("matches the id, org, path or an alias, all terms together", () => {
    expect(projectMatches(project, undefined, [])).toBe(true);
    expect(projectMatches(project, undefined, ["backend"])).toBe(true);
    expect(projectMatches(project, undefined, ["acme", "alpha"])).toBe(true);
    expect(projectMatches(project, undefined, ["acme", "beta"])).toBe(false);
  });
  it("also matches what the scan knows about the repo", () => {
    const repo = {
      name: "alpha-api",
      path: project.path,
      relPath: "alpha-api",
      remotes: [{ name: "origin", url: "git@github.com:a/b.git", host: "github" as const }],
      registered: true,
    };
    expect(projectMatches(project, repo, ["github"])).toBe(true);
  });
});

describe("groupByOrg", () => {
  it("groups in org order, leaves empty orgs out and puts unknown orgs last", () => {
    const items = [
      { org: "zed", id: 1 },
      { org: "acme", id: 2 },
      { org: "gone", id: 3 },
      { org: "acme", id: 4 },
    ];
    expect(groupByOrg(items, ["acme", "empty", "zed"]).map((g) => [g.org, g.items.map((i) => i.id)])).toEqual(
      [
        ["acme", [2, 4]],
        ["zed", [1]],
        ["gone", [3]],
      ],
    );
  });
});
