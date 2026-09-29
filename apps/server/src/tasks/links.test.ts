import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { fetchLink, fetchLinks, htmlToText, linkFileName } from "./links.ts";

const html = (body: string, headers: Record<string, string> = { "content-type": "text/html" }) =>
  new Response(body, { headers });

describe("htmlToText", () => {
  it("drops scripts, styles and tags, keeps block breaks and decodes entities", () => {
    expect(
      htmlToText(
        "<head><title>x</title></head><body><style>a{}</style><h1>Title</h1><p>One &amp; two &lt;3 &#65; &#x42;</p><ul><li>a</li><li>b</li></ul><script>bad()</script><!-- c --></body>",
      ),
    ).toBe("Title\n\nOne & two <3 A B\n\na\n\nb");
  });

  it("collapses blank lines and spaces", () => {
    expect(htmlToText("<p>  a   b  </p><p></p><p></p><p></p><p>c</p>")).toBe("a b\n\nc");
  });
});

describe("fetchLink", () => {
  it("returns markdown with the title and source", async () => {
    const page = await fetchLink("https://e.com/a", {
      fetchImpl: async () => html("<title>Hello &amp; bye</title><p>Body</p>"),
    });
    expect(page.markdown).toBe("# Hello & bye\n\nSource: https://e.com/a\n\nBody\n");
    expect(page.truncated).toBe(false);
  });

  it("keeps plain text and json as they are", async () => {
    const page = await fetchLink("https://e.com/a.json", {
      fetchImpl: async () => html('{"a":1}', { "content-type": "application/json" }),
    });
    expect(page.markdown).toBe('# https://e.com/a.json\n\nSource: https://e.com/a.json\n\n{"a":1}\n');
  });

  it("fails on a bad status and on content that is not text", async () => {
    await expect(
      fetchLink("https://e.com", { fetchImpl: async () => new Response("", { status: 500 }) }),
    ).rejects.toThrow("The server answered 500");
    await expect(
      fetchLink("https://e.com", { fetchImpl: async () => html("x", { "content-type": "application/pdf" }) }),
    ).rejects.toThrow("Cannot read application/pdf content");
  });

  it("stops reading at the size cap", async () => {
    const page = await fetchLink("https://e.com", {
      maxBytes: 10,
      fetchImpl: async () => html("<p>0123456789abcdef</p>"),
    });
    expect(page.truncated).toBe(true);
    expect(page.markdown).toContain("(Cut at 2 MB.)");
    expect(page.markdown).not.toContain("abcdef");
  });

  it("times out", async () => {
    const slow: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await expect(fetchLink("https://e.com", { fetchImpl: slow, timeoutMs: 20 })).rejects.toThrow();
  });
});

describe("fetchLinks", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  it("keeps a timeout on the attachment as a plain message", async () => {
    const slow: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const [a] = await fetchLinks(["https://e.com/slow"], join(dir, "attachments"), {
      fetchImpl: slow,
      timeoutMs: 10,
    });
    expect(a).toEqual({
      id: "link-1",
      kind: "link",
      name: "https://e.com/slow",
      url: "https://e.com/slow",
      error: "The page took more than 10 seconds to answer",
    });
  });

  it("stores each link once and numbers the files", async () => {
    let calls = 0;
    const list = await fetchLinks(["https://e.com/a", "https://e.com/b"], join(dir, "attachments"), {
      fetchImpl: async () => {
        calls++;
        return html(`<title>T${calls}</title><p>x</p>`);
      },
    });
    expect(list.map((a) => a.path)).toEqual(["link-1-e-com-a.md", "link-2-e-com-b.md"]);
    expect(await readFile(join(dir, "attachments", "link-2-e-com-b.md"), "utf8")).toContain(
      "Source: https://e.com/b",
    );
    expect(calls).toBe(2);
    await rm(join(dir, "attachments"), { recursive: true });
    await mkdir(join(dir, "attachments"));
  });
});

describe("linkFileName", () => {
  it("makes a short slug from the host and path", () => {
    expect(linkFileName(3, "https://docs.example.com/guide/Getting-Started?x=1")).toBe(
      "link-3-docs-example-com-guide-getting-started.md",
    );
    expect(linkFileName(1, "not a url")).toBe("link-1-not-a-url.md");
  });
});
