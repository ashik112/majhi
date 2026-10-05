import { describe, expect, it } from "vitest";
import { parseMentions, parsePathMentions } from "./rooms.ts";
import { parseTaskText } from "./task-parse.ts";
import type { ParseContext } from "./tasks.ts";

const ctx: ParseContext = {
  projects: [
    { id: "acme-api", org: "acme", aliases: ["api", "backend"] },
    { id: "acme-web", org: "acme", aliases: ["web", "frontend"] },
    { id: "beta-app", org: "beta", aliases: ["app"] },
  ],
  agents: [{ id: "builder" }, { id: "acme-lead" }],
};

describe("repos", () => {
  it("finds a project by alias", () => {
    const p = parseTaskText("add a health endpoint to api from develop", ctx);
    expect(p.repos).toEqual([{ project: "acme-api", match: "api" }]);
    expect(p.kind).toBe("code");
    expect(p.org).toBe("acme");
    expect(p.warnings).toEqual([]);
  });

  it("finds a project by id and keeps the text as typed", () => {
    expect(parseTaskText("Fix ACME-Web layout", ctx).repos).toEqual([
      { project: "acme-web", match: "ACME-Web" },
    ]);
  });

  it("lists repos in order of first mention, once each", () => {
    const p = parseTaskText("update web, then backend, then web again and api", ctx);
    expect(p.repos.map((r) => r.project)).toEqual(["acme-web", "acme-api"]);
  });

  it("uses the earliest of an id and its aliases", () => {
    const p = parseTaskText("frontend and acme-web", ctx);
    expect(p.repos).toEqual([{ project: "acme-web", match: "frontend" }]);
  });

  it("matches whole words only", () => {
    expect(parseTaskText("rapid webinar apis", ctx).repos).toEqual([]);
    expect(parseTaskText("fix the my-api thing", ctx).repos).toEqual([]);
    expect(parseTaskText("fix api-gateway", ctx).repos).toEqual([]);
    expect(parseTaskText("open src/api/routes.ts and api.ts", ctx).repos).toEqual([]);
  });

  it("matches next to punctuation", () => {
    expect(parseTaskText("Fix (api), then web.", ctx).repos.map((r) => r.project)).toEqual([
      "acme-api",
      "acme-web",
    ]);
  });

  it("ignores names inside links, mentions and paths", () => {
    const p = parseTaskText("see https://github.com/acme/api/issues/4 and ask @builder on feat/web", ctx);
    expect(p.repos).toEqual([]);
    expect(p.kind).toBe("chat");
  });

  it("has no repo, no warning and kind chat when nothing matches", () => {
    const p = parseTaskText("what is a monad", ctx);
    expect(p).toEqual({
      title: "what is a monad",
      repos: [],
      mentions: [],
      links: [],
      kind: "chat",
      warnings: [],
    });
  });
});

describe("orgs", () => {
  it("sets org when every repo shares one", () => {
    expect(parseTaskText("api and web", ctx).org).toBe("acme");
  });

  it("warns and leaves org unset when repos span orgs", () => {
    const p = parseTaskText("api and app", ctx);
    expect(p.org).toBeUndefined();
    expect(p.warnings).toEqual(["Repos from more than one workspace: acme, beta"]);
  });

  it("orders the orgs by first mention", () => {
    expect(parseTaskText("app then api", ctx).warnings).toEqual([
      "Repos from more than one workspace: beta, acme",
    ]);
  });
});

describe("path mentions", () => {
  it("reads @/absolute paths, without trailing punctuation, code or quotes", () => {
    const text = [
      "for @/Users/owner/Work/acme/api, run it. Also @/Users/owner/Work/acme/web/src.",
      "`@/Users/owner/in-code` and",
      "> @/Users/owner/quoted",
      "@/Users/owner/Work/acme/api again, @/Users/owner/../etc and email me@/not/a/mention",
      "@acme-lead stays an agent mention",
    ].join("\n");
    expect(parsePathMentions(text)).toEqual(["/Users/owner/Work/acme/api", "/Users/owner/Work/acme/web/src"]);
    expect(parseMentions(text, ["acme-lead"])).toEqual(["acme-lead"]);
  });
});
