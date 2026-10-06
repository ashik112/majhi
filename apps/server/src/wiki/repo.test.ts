import { CommitShaSchema, ContentHashSchema, type WikiPage, WikiPageSchema, wikiPageId } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";

const FIRST = CommitShaSchema.parse("a".repeat(40));
const SECOND = CommitShaSchema.parse("b".repeat(40));
const HASH = ContentHashSchema.parse("c".repeat(64));
const OVERVIEW = wikiPageId({ kind: "overview" });

function page(over: Partial<WikiPage> = {}): WikiPage {
  return WikiPageSchema.parse({
    id: OVERVIEW,
    org: "acme",
    project: "acme-api",
    kind: "overview",
    title: "Overview",
    body: "The API answers the web app [1].",
    claims: [
      {
        n: 1,
        text: "The API answers the web app.",
        proven: true,
        sources: [{ repo: "acme-api", commit: FIRST, path: "src/app.py", lines: [10, 14], hash: HASH }],
      },
    ],
    builtFrom: { "acme-api": FIRST },
    v: 1,
    ...over,
  });
}

describe("the wiki store", () => {
  it("keeps the version a save replaces, and writes nothing when the page did not change", () => {
    const { wiki } = new Store(":memory:");
    expect(wiki.save(page())).toBe(true);
    expect(wiki.save(page())).toBe(false);
    expect(wiki.versionCount("acme", "acme-api", OVERVIEW)).toBe(0);

    expect(
      wiki.save(page({ body: "The API serves the web app [1].", builtFrom: { "acme-api": SECOND } })),
    ).toBe(true);
    expect(wiki.page("acme", "acme-api", OVERVIEW)?.page.body).toBe("The API serves the web app [1].");
    const versions = wiki.versions("acme", "acme-api", OVERVIEW);
    expect(versions.map((v) => [v.seq, v.page.body, v.page.builtFrom])).toEqual([
      [1, "The API answers the web app [1].", { "acme-api": FIRST }],
    ]);

    wiki.save(page({ body: "Third.", builtFrom: { "acme-api": SECOND } }));
    expect(wiki.versions("acme", "acme-api", OVERVIEW).map((v) => v.seq)).toEqual([2, 1]);
  });

  it("reads a row that no longer parses as absent, and still keeps its text when the page is saved again", () => {
    const store = new Store(":memory:");
    const { wiki } = store;
    wiki.save(page());
    store.raw.prepare("UPDATE wiki_pages SET page = ?").run('{"id":"overview","title":');
    expect(wiki.page("acme", "acme-api", OVERVIEW)).toBeUndefined();
    expect(wiki.pages("acme", "acme-api")).toEqual([]);

    store.raw
      .prepare("UPDATE wiki_pages SET page = ?")
      .run(JSON.stringify({ id: OVERVIEW, org: "acme", kind: "nonsense" }));
    expect(wiki.page("acme", "acme-api", OVERVIEW)).toBeUndefined();

    wiki.save(page());
    expect(wiki.page("acme", "acme-api", OVERVIEW)?.page.title).toBe("Overview");
    const kept = store.raw.prepare("SELECT page FROM wiki_page_versions").all() as { page: string }[];
    expect(kept.map((r) => JSON.parse(r.page))).toEqual([{ id: "overview", org: "acme", kind: "nonsense" }]);
  });
});
