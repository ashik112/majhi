import { describe, expect, it } from "vitest";
import { parseMentions, parsePathMentions } from "./rooms.ts";
import { parseTaskText, TITLE_MAX, taskKindOf } from "./task-parse.ts";
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

describe("kind ops", () => {
  const kind = (text: string) => parseTaskText(text, ctx).kind;

  it("infers ops for an investigation or an incident", () => {
    expect(kind("why is the api down in prod")).toBe("ops");
    expect(kind("Investigate the slow checkout")).toBe("ops");
    expect(kind("Incident: login errors since 9am")).toBe("ops");
    expect(kind("outage in eu region")).toBe("ops");
    expect(kind("debug the queue backlog in production")).toBe("ops");
    expect(kind("why are the nightly jobs failing")).toBe("ops");
  });

  it("keeps the repos an investigation names", () => {
    const p = parseTaskText("why is the api down in prod", ctx);
    expect(p.repos).toEqual([{ project: "acme-api", match: "api" }]);
  });

  it("stays code when the code changes", () => {
    expect(kind("investigate the timeout and fix it in api")).toBe("code");
    expect(kind("add a health endpoint to api from develop")).toBe("code");
    expect(kind("incident follow-up: implement retries in api")).toBe("code");
    expect(kind("why is the api down in prod, on fix/timeouts")).toBe("code");
  });

  it("stays chat for plain questions", () => {
    expect(kind("what is a monad")).toBe("chat");
    expect(kind("why is the sky blue")).toBe("chat");
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
    expect(parseTaskText("app then api", ctx).warnings).toEqual(["Repos from more than one workspace: beta, acme"]);
  });
});

describe("prose is not a base or a branch", () => {
  it("has no base or branch field", () => {
    const p = parseTaskText("api from develop on feature/x", ctx);
    expect(p).not.toHaveProperty("base");
    expect(p).not.toHaveProperty("branch");
    expect(ParsedTaskSchema.shape).not.toHaveProperty("base");
    expect(ParsedTaskSchema.shape).not.toHaveProperty("branch");
  });

  // Keywords are hyphen-free here on purpose: these are the briefs that used to trip the parser.
  it.each([
    ["the words X on /profile", "chat"],
    ["move the code from acme-web into this project", "code"],
    ["API base URLs are resolved once at startup from window.location.hostname", "code"],
    ["the screenshot was taken with Playwright", "chat"],
    ["work on main later", "chat"],
    ["use the default branch", "chat"],
    ["api branch fix/y", "code"],
  ])("reads %s only as prose", (text, kind) => {
    const p = parseTaskText(text, ctx);
    expect(p.kind).toBe(kind);
    expect(p).not.toHaveProperty("base");
    expect(p).not.toHaveProperty("branch");
  });

  // Whole briefs the way leads write them (PRV-64 got base "Playwright", PRV-66 got base "branch").
  it.each([
    "Add screenshots to the api docs\n\nTake them with the Playwright tool. The ones taken with Playwright last week are stale.",
    "Task text picks the base branch by mistake\n\nThe parser reads the base branch from prose. Use the default branch instead, and work on main later.",
    "Tidy the web footer\n\nProduct names like Acme Cloud, GitHub, Docker and Playwright show up here.\nThe branch protection on main stays. Rebase on develop is not needed, branch: none.",
    "Branch develop from main\n\nbase: staging\nbranch: feature/x\nfrom release/1.2",
  ])("reads only prose, never a base or a branch, in: %s", (text) => {
    const p = parseTaskText(text, ctx);
    expect(Object.keys(p).sort()).toEqual(
      [
        "kind",
        "links",
        "mentions",
        "repos",
        "title",
        "warnings",
        ...(p.org === undefined ? [] : ["org"]),
      ].sort(),
    );
    expect(p.title).toBe(text.split("\n")[0]);
    expect(p.warnings).toEqual([]);
  });

  it("does not turn on /profile into a code task", () => {
    const text = "Investigate why the page is down in prod. Check the screenshots on /profile";
    expect(parseTaskText(text, ctx).kind).toBe("ops");
    expect(taskKindOf(text, false)).toBe("ops");
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

  it("is cut at 120 characters, at a word, with an ellipsis", () => {
    expect(parseTaskText("x".repeat(200), ctx).title).toBe(`${"x".repeat(TITLE_MAX - 1)}…`);
    const words = parseTaskText("word ".repeat(40), ctx).title;
    expect(words.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(words.endsWith("word…")).toBe(true);
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
