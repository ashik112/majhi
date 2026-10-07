import { type WikiFact, WikiFactSchema, type WikiFactsFile } from "@majhi/shared";
import { describe, expect, it } from "vitest";
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
