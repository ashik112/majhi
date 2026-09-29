import { describe, expect, it } from "vitest";
import { parseTaskText, TITLE_MAX } from "./task-parse.ts";
import { type ParseContext, ParsedTaskSchema } from "./tasks.ts";

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
    expect(p.base).toBe("develop");
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

  it("ignores names inside links, mentions, and base or branch phrases", () => {
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
    expect(p.warnings).toEqual(["Repos from more than one org: acme, beta"]);
  });

  it("orders the orgs by first mention", () => {
    expect(parseTaskText("app then api", ctx).warnings).toEqual(["Repos from more than one org: beta, acme"]);
  });
});

describe("base and branch", () => {
  it.each([
    ["api from develop", "develop"],
    ["api base: main", "main"],
    ["api base main", "main"],
    ["api base:main", "main"],
    ["api off release/2.1", "release/2.1"],
    ["api FROM Develop.", "Develop"],
    ["api from origin/main, please", "origin/main"],
  ])("reads the base from %s", (text, base) => {
    expect(parseTaskText(text, ctx).base).toBe(base);
  });

  it("skips plain speech after from and off", () => {
    expect(parseTaskText("copy the logic from the billing module in api", ctx).base).toBeUndefined();
    expect(parseTaskText("api from scratch", ctx).base).toBeUndefined();
  });

  it("takes the first real base phrase", () => {
    expect(parseTaskText("from the top, api from develop, off main", ctx).base).toBe("develop");
  });

  it.each([
    ["api on feature/health", "feature/health"],
    ["api branch fix/y", "fix/y"],
    ["api branch: fix/y.", "fix/y"],
  ])("reads the working branch from %s", (text, branch) => {
    expect(parseTaskText(text, ctx).branch).toBe(branch);
  });

  it("needs a slash in the working branch", () => {
    expect(parseTaskText("api on develop", ctx).branch).toBeUndefined();
    expect(parseTaskText("work on api", ctx).branch).toBeUndefined();
    expect(parseTaskText("api branch hotfix", ctx).branch).toBeUndefined();
  });

  it("reads base and branch together", () => {
    const p = parseTaskText("api from develop on feature/x", ctx);
    expect(p.base).toBe("develop");
    expect(p.branch).toBe("feature/x");
  });

  it("does not read phrases inside links", () => {
    const p = parseTaskText("see https://example.com/from/develop and https://example.com/on/feat/x", ctx);
    expect(p.base).toBeUndefined();
    expect(p.branch).toBeUndefined();
  });
});

describe("mentions", () => {
  it("collects known agents once, in order", () => {
    expect(parseTaskText("@acme-lead plan it, @builder build it, @acme-lead again", ctx).mentions).toEqual([
      "acme-lead",
      "builder",
    ]);
  });

  it("warns about unknown agents", () => {
    const p = parseTaskText("ask @ghost and @ghost", ctx);
    expect(p.mentions).toEqual([]);
    expect(p.warnings).toEqual(["Unknown agent @ghost"]);
  });

  it("is case-insensitive", () => {
    expect(parseTaskText("@Builder go", ctx).mentions).toEqual(["builder"]);
  });

  it("ignores emails and file mentions", () => {
    const p = parseTaskText("mail me@builder.dev, look at @src/index.ts and @README.md", ctx);
    expect(p.mentions).toEqual([]);
    expect(p.warnings).toEqual([]);
  });
});

describe("links", () => {
  it("collects http and https links without trailing punctuation, once", () => {
    const p = parseTaskText(
      "read https://example.com/spec. Also (http://example.org/a?b=1), https://example.com/spec",
      ctx,
    );
    expect(p.links).toEqual(["https://example.com/spec", "http://example.org/a?b=1"]);
  });

  it("does not take other schemes", () => {
    expect(parseTaskText("ftp://example.com and mailto:a@b.c", ctx).links).toEqual([]);
  });
});

describe("title", () => {
  it("is the first non-empty line with mentions kept", () => {
    expect(parseTaskText("\n\n  @builder add health to api  \nsecond line", ctx).title).toBe(
      "@builder add health to api",
    );
  });

  it("is cut at 120 characters", () => {
    const title = parseTaskText("x".repeat(200), ctx).title;
    expect(title).toBe("x".repeat(TITLE_MAX));
  });

  it("is empty for blank text", () => {
    expect(parseTaskText("   \n ", ctx).title).toBe("");
  });
});

it("returns a value that fits the contract schema", () => {
  const p = parseTaskText("api from develop on feat/x @builder https://e.com/x @ghost", ctx);
  expect(ParsedTaskSchema.parse(p)).toEqual(p);
});

it("handles long text quickly", () => {
  const text = "add a thing to api and web from develop. ".repeat(2000);
  const started = Date.now();
  parseTaskText(text, ctx);
  expect(Date.now() - started).toBeLessThan(200);
});
