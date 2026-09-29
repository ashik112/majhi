import type { ProjectView } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { aliasClashes, projectForPath, projectIdError, suggestProjectId } from "./project-model";

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
