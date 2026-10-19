import { CommitShaSchema, ContentHashSchema, type WikiPage, WikiPageSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../memory/db.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import type { AgentScope } from "../memory/mcp.ts";
import { Store } from "../store/index.ts";
import { WikiIndex } from "./search.ts";
import { WikiToolRefusal, WikiTools } from "./tools.ts";

const SHA = CommitShaSchema.parse("a".repeat(40));
const HASH = ContentHashSchema.parse("c".repeat(64));

function pageOf(org: string, project: string, kind: "overview" | "flow", text: string): WikiPage {
  return WikiPageSchema.parse({
    id: kind === "overview" ? "overview" : "flow:pay",
    org,
    project,
    kind,
    title: kind === "overview" ? "Overview" : "Pay",
    body: `${text} [1]`,
    claims: [
      {
        n: 1,
        text,
        proven: true,
        sources: [{ repo: project, commit: SHA, path: "src/app.py", lines: [3, 5], hash: HASH }],
      },
    ],
    roles: kind === "overview" ? [{ role: "backend", where: "src", tech: "Python", claim: 1 }] : [],
    builtFrom: { [project]: SHA },
    v: 1,
  });
}

async function world(on: Record<string, boolean>, registered: Record<string, string[]> = {}) {
  const store = new Store(":memory:");
  const db = openMemoryDb(":memory:");
  const embedder = new HashEmbedder();
  const index = new WikiIndex(db, (texts) => embedder.embed(texts));
  const pages = [
    pageOf("acme", "api", "overview", "The Acme billing service charges cards through Stripe."),
    pageOf("acme", "api", "flow", "A payment starts at the charge route of the Acme billing service."),
    pageOf(
      "globex",
      "shop",
      "overview",
      "The Globex shop keeps its secret pricing rules in the vault module.",
    ),
  ];
  for (const p of pages) {
    store.wiki.save(p);
    await index.put(p);
  }
  store.wiki.saveState("acme", "api", {
    builtCommit: SHA,
    sources: {},
    rules: 1,
    gaps: { couldNot: [], failed: [] },
  });
  const enabled = async (org: string) => on[org] === true;
  const projects = async (org: string) => registered[org] ?? ["api", "shop"];
  return { store, index, tools: new WikiTools({ repo: store.wiki, enabled, index, projects }), enabled };
}

const acme: AgentScope = { org: "acme", scopes: ["global", "org:acme", "project:api"] };

describe("the wiki tool", () => {
  it("never finds the pages of a project that was removed from majhi", async () => {
    const { tools } = await world({ acme: true }, { acme: [] });
    expect(await tools.call(acme, { action: "list" })).toBe("No project of this workspace has a wiki yet.");
    expect(await tools.call(acme, { action: "search", words: "Acme billing service charges cards" })).toBe(
      "Nothing in the wiki matches those words.",
    );
    await expect(
      tools.call(acme, { action: "read", project: "api", page: "overview" }),
    ).rejects.toBeInstanceOf(WikiToolRefusal);
  });

  it("is not offered, and refuses a call, while the workspace has the wiki off", async () => {
    const { tools } = await world({ acme: false, globex: true });
    expect(await tools.offered(acme)).toBe(false);
    await expect(tools.call(acme, { action: "list" })).rejects.toThrow("The wiki is off for this workspace.");
    expect(await tools.offered({ org: undefined, scopes: ["global"] })).toBe(false);
  });
});

describe("a removed project", () => {
  it("leaves no pages, state or search pieces behind, and the workspace keeps its other projects", async () => {
    const { store, index } = await world({ acme: true });
    store.wiki.removeProject("acme", "api");
    index.dropProject("acme", "api");
    expect(store.wiki.pages("acme", "api")).toEqual([]);
    expect(store.wiki.state("acme", "api").builtCommit).toBeUndefined();
    expect(await index.search({ org: "acme", projects: ["api"], query: "billing service" })).toEqual([]);
    expect(store.wiki.pages("globex", "shop")).toHaveLength(1);
  });
});
