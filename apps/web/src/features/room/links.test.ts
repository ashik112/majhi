import { describe, expect, it } from "vitest";
import { classifyTarget, dirOf, isWebHref, presentFileLink, safeHref, taskPathOf } from "./links";

const folder = "/tasks/ACM-1";

describe("safeHref", () => {
  it("keeps web, mail and path targets", () => {
    expect(safeHref("https://a.dev/x")).toBe("https://a.dev/x");
    expect(safeHref("mailto:a@b.dev")).toBe("mailto:a@b.dev");
    expect(safeHref("media/a.png")).toBe("media/a.png");
    expect(safeHref("file:///tasks/ACM-1/a.md")).toBe("file:///tasks/ACM-1/a.md");
  });

  it("drops other schemes, protocol-relative urls and anchors", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:image/png;base64,AAA",
      "vbscript:x",
      "//evil.example/a",
      "#top",
      "",
    ]) {
      expect(safeHref(href), href).toBeUndefined();
    }
  });

  it("names web links", () => {
    expect(isWebHref("https://a.dev/x")).toBe(true);
    expect(isWebHref("media/a.png")).toBe(false);
  });
});

describe("taskPathOf", () => {
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
    expect(taskPathOf("/tasks/ACM-1/../x", folder)).toBeUndefined();
    expect(taskPathOf("", folder)).toBeUndefined();
  });

  it("resolves against the folder of the open document, and never leaves the task folder", () => {
    expect(taskPathOf("a.png", folder, "docs")).toBe("docs/a.png");
    expect(taskPathOf("../media/a.png", folder, "docs")).toBe("media/a.png");
    expect(taskPathOf("sub/../b.md", folder, "docs")).toBe("docs/b.md");
    expect(taskPathOf("../../x", folder, "docs")).toBeUndefined();
    expect(taskPathOf("../x", folder, "")).toBeUndefined();
    // Absolute paths ignore the document folder.
    expect(taskPathOf("/tasks/ACM-1/a.md", folder, "docs")).toBe("a.md");
  });
});

describe("dirOf", () => {
  it("returns the folder part", () => {
    expect(dirOf("docs/a.md")).toBe("docs");
    expect(dirOf("a.md")).toBe("");
    expect(dirOf("a/b/c.md")).toBe("a/b");
  });
});

describe("classifyTarget", () => {
  it("tells web links from task files and from nothing", () => {
    expect(classifyTarget("https://example.com/docs", folder)).toEqual({
      type: "web",
      href: "https://example.com/docs",
    });
    expect(classifyTarget("MOVES.md", folder)).toEqual({ type: "file", path: "MOVES.md", kind: "markdown" });
    expect(classifyTarget("media/report.html", folder)).toEqual({
      type: "file",
      path: "media/report.html",
      kind: "page",
    });
    expect(classifyTarget("/tasks/ACM-1/src/a.ts", folder)).toEqual({
      type: "file",
      path: "src/a.ts",
      kind: "text",
    });
    expect(classifyTarget("media/a.png", folder)).toMatchObject({ kind: "image" });
    expect(classifyTarget("media/a.mp4", folder)).toMatchObject({ kind: "video" });
    expect(classifyTarget("media/a.mp3", folder)).toMatchObject({ kind: "audio" });
    expect(classifyTarget("report.pdf", folder)).toMatchObject({ kind: "pdf" });
  });

  it("gives nothing for unsafe or outside targets", () => {
    for (const t of [
      "javascript:alert(1)",
      "//evil.dev/a",
      "#x",
      "/etc/passwd",
      "../x.md",
      "data:text/html,x",
    ]) {
      expect(classifyTarget(t, folder), t).toEqual({ type: "none" });
    }
  });
});

describe("presentFileLink", () => {
  it("is always inline inside a sentence", () => {
    for (const kind of ["markdown", "image", "pdf", "page", "video", "audio", "text"] as const) {
      expect(presentFileLink(kind, false), kind).toBe("inline");
    }
  });

  it("is a card on its own line, and a player for clips", () => {
    expect(presentFileLink("markdown", true)).toBe("card");
    expect(presentFileLink("page", true)).toBe("card");
    expect(presentFileLink("image", true)).toBe("card");
    expect(presentFileLink("video", true)).toBe("player");
    expect(presentFileLink("audio", true)).toBe("player");
  });
});
