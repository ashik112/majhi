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

async function world(on: Record<string, boolean>) {
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
  return { store, index, tools: new WikiTools({ repo: store.wiki, enabled, index }), enabled };
}

const acme: AgentScope = { org: "acme", scopes: ["global", "org:acme", "project:api"] };

describe("the wiki tool", () => {
  it("answers from the task's own workspace and never shows another workspace's pages", async () => {
    const { tools } = await world({ acme: true, globex: true });
    expect(await tools.call(acme, { action: "list" })).toBe(
      "Wiki of api (built from aaaaaaa):\n- flow:pay: Pay\n- overview: Overview",
    );
    // Words that only Globex's page holds find nothing in Acme's task.
    expect(await tools.call(acme, { action: "search", words: "secret pricing rules vault" })).not.toContain(
      "Globex",
    );
    expect(
      await tools.call(acme, { action: "sources", claim: "secret pricing rules vault module" }),
    ).not.toContain("Globex");
    // Naming the other workspace's project is refused, and the refusal does not name it.
    await expect(tools.call(acme, { action: "read", project: "shop", page: "overview" })).rejects.toThrow(
      "shop is not a project of this task's workspace. Its projects: api.",
    );
    await expect(tools.call(acme, { action: "list", project: "shop" })).rejects.toBeInstanceOf(
      WikiToolRefusal,
    );
    // The same words do find Acme's own pages, with the file and lines behind the claim.
    const found = await tools.call(acme, { action: "sources", claim: "Acme billing charges cards Stripe" });
    expect(found).toContain("src/app.py:3-5 at aaaaaaa (api)");
    expect(found).toContain("proven, on api/overview, claim 1");
  });

  it("is not offered, and refuses a call, while the workspace has the wiki off", async () => {
    const { tools } = await world({ acme: false, globex: true });
    expect(await tools.offered(acme)).toBe(false);
    await expect(tools.call(acme, { action: "list" })).rejects.toThrow("The wiki is off for this workspace.");
    expect(await tools.offered({ org: undefined, scopes: ["global"] })).toBe(false);
  });
});

describe("the workspace pages", () => {
  const workspacePage = (org: string, text: string): WikiPage =>
    WikiPageSchema.parse({
      id: "overview",
      org,
      kind: "overview",
      title: "System overview",
      body: `${text} [1]`,
      claims: [
        {
          n: 1,
          text,
          proven: true,
          sources: [{ repo: "api", commit: SHA, path: "src/app.py", lines: [3, 5], hash: HASH }],
        },
      ],
      builtFrom: { api: SHA },
      v: 1,
    });

  it("are listed, read and searched for the task's workspace only", async () => {
    const { store, index, tools } = await world({ acme: true, globex: true });
    for (const page of [
      workspacePage("acme", "The Acme web app calls the billing API to charge cards."),
      workspacePage("globex", "The Globex storefront calls the vault service for pricing."),
    ]) {
      store.wiki.save(page);
      await index.put(page);
    }
    const found = await tools.call(acme, { action: "list" });
    expect(found).toContain("Wiki of the workspace");
    expect(found).toContain("- overview: System overview");
    const read = await tools.call(acme, { action: "read", workspace: true, page: "overview" });
    expect(read).toContain("Acme web app calls the billing API");
    expect(read).not.toContain("Globex");
    expect(await tools.call(acme, { action: "search", words: "storefront vault pricing" })).not.toContain(
      "Globex",
    );
    const hits = await tools.call(acme, { action: "search", words: "web app calls billing API" });
    expect(hits).toContain("workspace/overview");
  });
});
