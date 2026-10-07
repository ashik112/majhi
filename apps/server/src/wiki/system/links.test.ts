import {
  type OwnerAnswerTarget,
  type WikiAnswer,
  type WikiFact,
  WikiFactSchema,
  type WikiFactsFile,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { answerAddress } from "./answers.ts";
import { buildSystem, type SystemProject } from "./links.ts";
import { loadSystem } from "./load.ts";

const SHA = "a".repeat(40);
const HASH = "b".repeat(64);
const source = (repo: string, path: string, line: number) => ({
  repo,
  commit: SHA,
  path,
  lines: [line, line],
  hash: HASH,
});

const route = (repo: string, method: string, path: string, line = 1): WikiFact =>
  WikiFactSchema.parse({
    id: `${repo}:entry:http-${method}-${path.replaceAll("{", "_").replaceAll("}", "_").replaceAll("*", "S")}@api.py:${line}`,
    repo,
    kind: "entry",
    entry: { type: "http", method, path },
    sources: [source(repo, "api.py", line)],
    basis: "declared",
  });

const call = (repo: string, method: string, path: string, line = 1, extra: object = {}): WikiFact =>
  WikiFactSchema.parse({
    id: `${repo}:call:${method}-${path.replaceAll("{", "_").replaceAll("}", "_").replaceAll("*", "S")}@client.ts:${line}`,
    repo,
    kind: "call",
    method,
    path,
    sources: [source(repo, "client.ts", line)],
    basis: "declared",
    ...extra,
  });

const unit = (repo: string, name: string, builds: boolean, role = "backend"): WikiFact =>
  WikiFactSchema.parse({
    id: `${repo}:unit:${name}`,
    repo,
    kind: "unit",
    name,
    role,
    builds,
    sources: [source(repo, "compose.yml", 3)],
    basis: "declared",
  });

const endpoint = (repo: string, host: string, port?: number, scope?: string): WikiFact =>
  WikiFactSchema.parse({
    id: `${repo}:endpoint:${scope === undefined ? "" : `${scope}@`}${host}${port === undefined ? "" : `:${port}`}`,
    repo,
    kind: "endpoint",
    host,
    ...(port === undefined ? {} : { port }),
    ...(scope === undefined ? {} : { scope }),
    keys: ["API_URL"],
    sources: [source(repo, ".env.example", 2)],
    basis: "config",
  });

const project = (id: string, facts: WikiFact[], declared: string[] = []): SystemProject => ({
  id,
  facts,
  declared,
});

const view = (projects: SystemProject[], answers: WikiAnswer[] = []) =>
  buildSystem({ org: "acme", projects, answers });

describe("calls link to a route only when the match is exact", () => {
  const api = project("acme-api", [
    route("acme-api", "POST", "/api/v1/login"),
    route("acme-api", "GET", "/api/v1/users/{user_id}", 2),
    route("acme-api", "GET", "/api/v1/users/me", 3),
    route("acme-api", "GET", "/api/v1/items", 4),
    route("acme-api", "GET", "/api/v1/items/{id}", 5),
  ]);
  const admin = project("acme-admin", [route("acme-admin", "GET", "/api/v1/items", 9)]);

  it("takes a literal route before a parameter one, and a filled-in part only for a parameter", () => {
    const web = project("acme-web", [
      call("acme-web", "GET", "/api/v1/users/me", 1),
      call("acme-web", "GET", "/api/v1/users/{}", 2),
      call("acme-web", "GET", "/api/v1/items/{}", 3),
    ]);
    const out = view([api, web]);
    expect(out.links.map((l) => [l.label, l.to.fact])).toEqual([
      ["GET /api/v1/items/{}", "acme-api:entry:http-GET-/api/v1/items/_id_@api.py:5"],
      ["GET /api/v1/users/{}", "acme-api:entry:http-GET-/api/v1/users/_user_id_@api.py:2"],
      ["GET /api/v1/users/me", "acme-api:entry:http-GET-/api/v1/users/me@api.py:3"],
    ]);
  });

  it("does not link a partial path, the wrong method or an unknown route: it is an unlinked call with its line", () => {
    const web = project("acme-web", [
      call("acme-web", "GET", "/api/v1/{}", 1),
      call("acme-web", "DELETE", "/api/v1/login", 2),
      call("acme-web", "GET", "/api/v1/legacy/ping", 3),
      call("acme-web", "GET", "/items", 4),
    ]);
    const out = view([api, web]);
    expect(out.links).toEqual([]);
    expect(out.unlinked.map((u) => [u.source.path, u.source.lines[0], u.why])).toEqual([
      ["client.ts", 1, "no-route"],
      ["client.ts", 2, "no-route"],
      ["client.ts", 3, "no-route"],
      ["client.ts", 4, "no-route"],
    ]);
  });

  it("does not guess between two projects that both have the route", () => {
    const web = project("acme-web", [call("acme-web", "GET", "/api/v1/items", 1)]);
    const out = view([api, admin, web]);
    expect(out.links).toEqual([]);
    expect(out.unlinked).toMatchObject([{ why: "ambiguous", matches: ["acme-admin", "acme-api"] }]);
  });

  it("reaches a route under a mount prefix the facts never saw, and only with two parts to compare", () => {
    const web = project("acme-web", [
      call("acme-web", "GET", "/oms/api/v1/items", 1),
      call("acme-web", "POST", "/oms/api/v1/login", 2),
    ]);
    const lone = project("acme-lone", [route("acme-lone", "GET", "/health")]);
    const caller = project("acme-job", [call("acme-job", "GET", "/api/v1/health", 1)]);
    const out = view([api, lone, web, caller]);
    expect(out.links.map((l) => `${l.from.project}>${l.to.project}`)).toEqual([
      "acme-web>acme-api",
      "acme-web>acme-api",
    ]);
    expect(out.unlinked.map((u) => u.project)).toEqual(["acme-job"]);
  });

  it("does not take a route with parameters for a path that only shares one name with it", () => {
    const wiki = project("acme-wiki", [
      route("acme-wiki", "GET", "/:org/:project/:commit/files/*", 1),
      route("acme-wiki", "GET", "/{id}", 2),
    ]);
    const web = project("acme-web", [
      call("acme-web", "GET", "/api/wiki/{}/files/readme.md", 1),
      call("acme-web", "GET", "/42", 2),
    ]);
    const out = view([wiki, web]);
    expect(out.links).toEqual([]);
    expect(out.unlinked.map((u) => u.path)).toEqual(["/api/wiki/{}/files/readme.md", "/42"]);
  });
});

describe("links from compose, settings and the owner", () => {
  const web = project("acme-web", [
    endpoint("acme-web", "backend", 8000),
    endpoint("acme-web", "localhost", 8000, "acme-web"),
    endpoint("acme-web", "api.stripe.com"),
    endpoint("acme-web", "metrics.example.test"),
  ]);
  const api = project("acme-api", [
    unit("acme-api", "backend", true),
    unit("acme-api", "db", false, "database"),
  ]);

  it("links an address to the one project that builds that compose service, and asks about the rest", () => {
    const out = view([web, api]);
    expect(out.links).toMatchObject([
      {
        basis: "declared",
        label: "backend:8000 (service)",
        from: { project: "acme-web" },
        to: { project: "acme-api", fact: "acme-api:unit:backend" },
      },
    ]);
    // A third-party service the catalog knows is not a question; a local address and an unknown host are.
    expect(out.questions.map((q) => [q.host, q.scope])).toEqual([
      ["localhost", "acme-web"],
      ["metrics.example.test", undefined],
    ]);
  });

  it("does not link when two projects build the same service name, or when only a datastore has it", () => {
    const twin = project("acme-twin", [unit("acme-twin", "backend", true)]);
    expect(view([web, api, twin]).links).toEqual([]);
    const onlyDb = project("acme-db", [unit("acme-db", "db", false, "database")]);
    const toDb = project("acme-job", [endpoint("acme-job", "db", 5432)]);
    expect(view([onlyDb, toDb]).links).toEqual([]);
  });

  it("puts declared links first and drops one to a project outside the workspace", () => {
    const declaring = project("acme-job", [], ["acme-api", "globex-api"]);
    const out = view([web, api, declaring]);
    expect(out.links.map((l) => [l.basis, l.from.project, l.to.project])).toEqual([
      ["declared", "acme-job", "acme-api"],
      ["declared", "acme-web", "acme-api"],
    ]);
  });

  it("applies the owner's answers, and forgets one when it is taken back", () => {
    const settle = (
      answers: WikiAnswer[],
      address: { host: string; port?: number; scope?: string },
      to?: OwnerAnswerTarget,
    ): WikiAnswer[] => [
      ...answerAddress(
        answers.flatMap((a) => (a.kind === "address" ? [a] : [])),
        { host: address.host, port: address.port, scope: address.scope },
        to,
      ).map((a) => ({ ...a, kind: "address" as const })),
    ];
    const local = { host: "localhost", port: 8000, scope: "acme-web" };
    let answers = settle([], local, { kind: "project", project: "acme-api" });
    answers = settle(answers, { host: "metrics.example.test" }, { kind: "outside" });
    let out = view([web, api], answers);
    expect(out.links.map((l) => [l.basis, l.label])).toEqual([
      ["declared", "backend:8000 (service)"],
      ["owner", "localhost:8000 (owner)"],
    ]);
    expect(out.questions).toEqual([]);
    answers = settle(answers, local, undefined);
    out = view([web, api], answers);
    expect(out.links.map((l) => l.basis)).toEqual(["declared"]);
    expect(out.questions.map((q) => q.host)).toEqual(["localhost"]);
  });
});

describe("a workspace's links stay among its own projects", () => {
  const file = (repo: string, facts: WikiFact[]): WikiFactsFile => ({
    repo,
    commit: SHA as never,
    rules: 1,
    reader: 2,
    facts,
  });
  it("reads only the projects the workspace has and never another workspace's facts", async () => {
    const asked: string[] = [];
    const facts: Record<string, WikiFactsFile> = {
      "acme-api": file("acme-api", [route("acme-api", "GET", "/api/v1/items")]),
      "acme-web": file("acme-web", [call("acme-web", "GET", "/api/v1/items", 1)]),
      "globex-api": file("globex-api", [route("globex-api", "GET", "/api/v1/orders")]),
      "globex-web": file("globex-web", [call("globex-web", "GET", "/api/v1/items", 1)]),
    };
    const sources = {
      projects: async (org: string) =>
        org === "acme"
          ? [
              { id: "acme-api", declared: [] },
              { id: "acme-web", declared: ["globex-api"] },
            ]
          : [
              { id: "globex-api", declared: [] },
              { id: "globex-web", declared: [] },
            ],
      facts: async (_org: string, project: string) => {
        asked.push(project);
        return facts[project];
      },
      answers: () => [],
    };
    const acme = await loadSystem("acme", sources);
    expect(asked.toSorted()).toEqual(["acme-api", "acme-web"]);
    expect(acme.view.links.map((l) => [l.from.project, l.to.project, l.basis])).toEqual([
      ["acme-web", "acme-api", "exact"],
    ]);
    const globex = await loadSystem("globex", sources);
    expect(globex.view.links).toEqual([]);
    expect(globex.view.unlinked.map((u) => u.project)).toEqual(["globex-web"]);
  });
});
