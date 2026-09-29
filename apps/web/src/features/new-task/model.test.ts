import { type OrgView, type ProjectView, parseTaskText } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  canAdd,
  chosenProjects,
  composeTaskText,
  groupProjects,
  initialProjects,
  namedProjects,
  togglePicked,
  typedText,
} from "./model";

const project = (id: string, org: string, aliases: string[] = []): ProjectView => ({
  id,
  org,
  path: `/w/${id}`,
  aliases,
  exists: true,
});
const org = (id: string, key: string): OrgView => ({
  id,
  name: id,
  key,
  accountCount: 0,
  agentCount: 0,
});

const projects = [project("api", "acme", ["backend"]), project("web", "acme"), project("dash", "north")];
const orgs = [org("acme", "ACM"), org("north", "NW")];
const ctx = { projects, agents: [] };

describe("groupProjects", () => {
  it("groups by org in the orgs' order", () => {
    const groups = groupProjects(projects, orgs, undefined);
    expect(groups.map((g) => [g.org, g.badge, g.projects.map((p) => p.id)])).toEqual([
      ["acme", "AC", ["api", "web"]],
      ["north", "NW", ["dash"]],
    ]);
  });
  it("puts the filtered org first", () => {
    expect(groupProjects(projects, orgs, "north").map((g) => g.org)).toEqual(["north", "acme"]);
  });
});

describe("initialProjects", () => {
  it("picks the only project of the filtered org", () => {
    expect(initialProjects(projects, "north")).toEqual(["dash"]);
  });
  it("picks nothing when the org has several or there is no filter", () => {
    expect(initialProjects(projects, "acme")).toEqual([]);
    expect(initialProjects(projects, undefined)).toEqual([]);
  });
});

describe("composeTaskText", () => {
  it("joins the title and details", () => {
    expect(typedText({ title: " Fix it ", details: "  more\n" })).toBe("Fix it\n\nmore");
    expect(composeTaskText({ title: "Fix it", details: "" }, [], [])).toBe("Fix it");
  });
  it("names a chosen project the words do not, so the server finds it", () => {
    const text = composeTaskText({ title: "Fix login", details: "It 500s" }, ["api", "web"], []);
    expect(text).toBe("Fix login\n\nIt 500s\n\nRepos: api, web");
    const parsed = parseTaskText(text, ctx);
    expect(namedProjects(parsed)).toEqual(["api", "web"]);
    expect(parsed.title).toBe("Fix login");
    expect(parsed.kind).toBe("code");
  });
  it("does not repeat a project the words already name", () => {
    const draft = { title: "fix x in api from develop", details: "" };
    const named = namedProjects(parseTaskText(typedText(draft), ctx));
    expect(named).toEqual(["api"]);
    const text = composeTaskText(draft, chosenProjects(named, ["web"]), named);
    expect(text).toBe("fix x in api from develop\n\nRepos: web");
    expect(parseTaskText(text, ctx)).toMatchObject({ base: "develop", kind: "code" });
  });
  it("keeps the base branch typed in the title", () => {
    const parsed = parseTaskText(
      composeTaskText({ title: "fix x in api from develop", details: "" }, ["api"], ["api"]),
      ctx,
    );
    expect(parsed.base).toBe("develop");
  });
  it("is a chat task without a project", () => {
    expect(
      parseTaskText(composeTaskText({ title: "Explain the auth flow", details: "" }, [], []), ctx).kind,
    ).toBe("chat");
  });
});

describe("chip choices", () => {
  it("shows what the words name and what was clicked, once each", () => {
    expect(chosenProjects(["api"], ["api", "web"])).toEqual(["api", "web"]);
  });
  it("toggles a picked project", () => {
    expect(togglePicked([], [], "web")).toEqual(["web"]);
    expect(togglePicked(["web"], [], "web")).toEqual([]);
  });
  it("leaves a project the words name locked on", () => {
    expect(togglePicked([], ["api"], "api")).toEqual([]);
  });
});

describe("canAdd", () => {
  it("needs a title and no upload or save in flight", () => {
    expect(canAdd({ title: " ", details: "x" }, false, false)).toBe(false);
    expect(canAdd({ title: "x", details: "" }, true, false)).toBe(false);
    expect(canAdd({ title: "x", details: "" }, false, true)).toBe(false);
    expect(canAdd({ title: "x", details: "" }, false, false)).toBe(true);
  });
});
