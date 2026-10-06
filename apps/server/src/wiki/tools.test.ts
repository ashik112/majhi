import { CommitShaSchema, ContentHashSchema, type WikiPage, WikiPageSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../memory/db.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import type { AgentScope } from "../memory/mcp.ts";
import { Store } from "../store/index.ts";
import { wikiNotes } from "./notes.ts";
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
  return { store, tools: new WikiTools({ repo: store.wiki, enabled, index }), enabled };
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

describe("TASK.md section", () => {
  it("is at most ten lines from the overview and flows, and empty while the wiki is off", async () => {
    const { store, enabled } = await world({ acme: true, globex: false });
    const notes = wikiNotes({ repo: store.wiki, enabled });
    expect(await notes("acme", ["api"])).toEqual([
      "api: backend Python (src).",
      "api flows: Pay (flow:pay).",
      "Details with file and line: the `wiki` tool of majhi-memory (list, read <page>, search <words>, sources <claim>).",
    ]);
    expect((await notes("acme", ["api", "api", "api", "api"])).length).toBeLessThanOrEqual(10);
    expect(await notes("globex", ["shop"])).toEqual([]);
    expect(await notes(undefined, ["api"])).toEqual([]);
  });
});
