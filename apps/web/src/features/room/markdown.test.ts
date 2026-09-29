import { describe, expect, it } from "vitest";
import { isWebHref, parseInline, parseMarkdown, safeHref, taskPathOf } from "./markdown-parse";

describe("parseInline", () => {
  it("reads code, bold, italic and links", () => {
    expect(parseInline("a `b` **c** *d* _e_ [f](https://x.dev)")).toEqual([
      { t: "text", text: "a " },
      { t: "code", text: "b" },
      { t: "text", text: " " },
      { t: "strong", children: [{ t: "text", text: "c" }] },
      { t: "text", text: " " },
      { t: "em", children: [{ t: "text", text: "d" }] },
      { t: "text", text: " " },
      { t: "em", children: [{ t: "text", text: "e" }] },
      { t: "text", text: " " },
      { t: "link", href: "https://x.dev", children: [{ t: "text", text: "f" }] },
    ]);
  });

  it("keeps markers without a partner as text while streaming", () => {
    expect(parseInline("start **bo")).toEqual([{ t: "text", text: "start **bo" }]);
    expect(parseInline("run `npm")).toEqual([{ t: "text", text: "run `npm" }]);
    expect(parseInline("see [docs](https://x")).toEqual([{ t: "text", text: "see [docs](https://x" }]);
  });

  it("does not treat snake_case or 2 * 3 as emphasis", () => {
    expect(parseInline("my_var_name")).toEqual([{ t: "text", text: "my_var_name" }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", text: "2 * 3 * 4" }]);
  });

  it("drops the anchor for links that are not web or mail", () => {
    expect(parseInline("[x](javascript:void)")).toEqual([{ t: "text", text: "x" }]);
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("mailto:a@b.dev")).toBe("mailto:a@b.dev");
  });

  it("leaves html as text", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([
      { t: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("splits paragraphs, headings, lists and rules", () => {
    const blocks = parseMarkdown("# Title\n\nOne\ntwo\n\n- a\n- b\n\n1. x\n2. y\n\n---");
    expect(blocks.map((b) => b.t)).toEqual(["h", "p", "list", "list", "hr"]);
    expect(blocks[1]).toEqual({ t: "p", children: [{ t: "text", text: "One\ntwo" }] });
    expect(blocks[2]).toMatchObject({ t: "list", ordered: false, items: [[{ text: "a" }], [{ text: "b" }]] });
    expect(blocks[3]).toMatchObject({ ordered: true, start: 1 });
  });

  it("reads a fenced block with its language and keeps markdown inside it literal", () => {
    expect(parseMarkdown("before\n```ts\nconst a = **1**;\n\nlet b\n```\nafter")).toEqual([
      { t: "p", children: [{ t: "text", text: "before" }] },
      { t: "code", lang: "ts", text: "const a = **1**;\n\nlet b" },
      { t: "p", children: [{ t: "text", text: "after" }] },
    ]);
  });

  it("renders an unclosed fence as code to the end, as it streams", () => {
    expect(parseMarkdown("Run:\n```sh\nnpm te")).toEqual([
      { t: "p", children: [{ t: "text", text: "Run:" }] },
      { t: "code", lang: "sh", text: "npm te" },
    ]);
    expect(parseMarkdown("```")).toEqual([{ t: "code", lang: "", text: "" }]);
  });

  it("keeps a longer fence open over a shorter one inside", () => {
    expect(parseMarkdown("````md\n```\ninner\n```\n````")).toEqual([
      { t: "code", lang: "md", text: "```\ninner\n```" },
    ]);
  });

  it("starts an ordered list at its own number and folds wrapped lines into the item", () => {
    const [list] = parseMarkdown("3. three\n   more\n4. four");
    expect(list).toMatchObject({ ordered: true, start: 3 });
    expect(list?.t === "list" && list.items).toHaveLength(2);
  });

  it("reads quotes as nested blocks", () => {
    expect(parseMarkdown("> a\n> **b**")).toEqual([
      {
        t: "quote",
        children: [
          {
            t: "p",
            children: [
              { t: "text", text: "a\n" },
              { t: "strong", children: [{ t: "text", text: "b" }] },
            ],
          },
        ],
      },
    ]);
  });

  it("handles empty text and CRLF", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("a\r\n\r\nb")).toHaveLength(2);
  });
});

describe("images and file links", () => {
  it("reads an image with its alt text, and a relative link as a link", () => {
    expect(parseInline("![Latency chart](media/chart.png) and [Report](media/report.html)")).toEqual([
      { t: "image", alt: "Latency chart", src: "media/chart.png" },
      { t: "text", text: " and " },
      { t: "link", href: "media/report.html", children: [{ t: "text", text: "Report" }] },
    ]);
  });

  it("does not make an image or a link of an unsafe source", () => {
    for (const src of [
      "![x](javascript:alert(1))",
      "![x](data:image/png;base64,AAA)",
      "[x](//evil.example/a)",
      "[x](#top)",
    ]) {
      expect(
        parseInline(src).every((node) => node.t === "text"),
        src,
      ).toBe(true);
    }
  });

  it("keeps a half-typed image as text while streaming", () => {
    expect(parseInline("see ![chart](media/ch")).toEqual([{ t: "text", text: "see ![chart](media/ch" }]);
  });

  it("names web links", () => {
    expect(isWebHref("https://a.dev/x")).toBe(true);
    expect(isWebHref("media/a.png")).toBe(false);
  });
});

describe("taskPathOf", () => {
  const folder = "/tasks/ACM-1";
  it("takes relative paths and paths under the folder", () => {
    expect(taskPathOf("media/chart.png", folder)).toBe("media/chart.png");
    expect(taskPathOf("./media/a%20b.png", folder)).toBe("media/a b.png");
    expect(taskPathOf("/tasks/ACM-1/media/chart.png", folder)).toBe("media/chart.png");
    expect(taskPathOf("file:///tasks/ACM-1/report.html#top", folder)).toBe("report.html");
    expect(taskPathOf("report.html?x=1", folder)).toBe("report.html");
  });

  it("refuses web links, other folders and climbing", () => {
    expect(taskPathOf("https://a.dev/x.png", folder)).toBeUndefined();
    expect(taskPathOf("/etc/passwd", folder)).toBeUndefined();
    expect(taskPathOf("/tasks/ACM-10/x.png", folder)).toBeUndefined();
    expect(taskPathOf("../secret.png", folder)).toBeUndefined();
    expect(taskPathOf("media/../../x", folder)).toBeUndefined();
    expect(taskPathOf("%2e%2e/x", folder)).toBeUndefined();
    expect(taskPathOf("", folder)).toBeUndefined();
  });
});
