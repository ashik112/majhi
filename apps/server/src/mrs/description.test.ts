import { describe, expect, it } from "vitest";
import { briefSummary, mrTitle, renderMrDescription, SUMMARY_MAX } from "./description.ts";

describe("renderMrDescription", () => {
  const siblings = [
    { project: "acme-api", url: "https://github.com/acme/api/pull/7" },
    { project: "acme-web", url: "https://gitlab.com/acme/web/-/merge_requests/3" },
  ];

  it("carries the task id, a summary of the brief and the sibling MRs in merge order", () => {
    const text = renderMrDescription({
      taskId: "ACM-12",
      title: "Add invoices",
      brief: "Add invoices\nThe API stores them.\nThe web lists them.",
      project: "acme-web",
      siblings,
    });
    expect(text).toContain("Task ACM-12: Add invoices");
    expect(text).toContain("The API stores them. The web lists them.");
    expect(text).toContain("1. acme-api: https://github.com/acme/api/pull/7");
    expect(text).toContain("2. acme-web (this MR): https://gitlab.com/acme/web/-/merge_requests/3");
    expect(text.indexOf("acme-api")).toBeLessThan(text.indexOf("acme-web (this MR)"));
  });

  it("says a sibling is not open yet", () => {
    const text = renderMrDescription({
      taskId: "ACM-12",
      title: "T",
      brief: "T",
      project: "acme-api",
      siblings: [{ project: "acme-api", url: "https://h/1" }, { project: "acme-web" }],
    });
    expect(text).toContain("2. acme-web: not open yet");
  });

  it("leaves the sibling list out for a single repo", () => {
    const text = renderMrDescription({
      taskId: "ACM-1",
      title: "T",
      brief: "T\nbody",
      project: "acme-api",
      siblings: [siblings[0] as (typeof siblings)[number]],
    });
    expect(text).not.toContain("Merge requests");
    expect(text).toContain("body");
  });
});

describe("briefSummary", () => {
  it("cuts a long brief at a word and marks the cut", () => {
    const summary = briefSummary("T", `T\n${"word ".repeat(400)}`);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX + 3);
    expect(summary.endsWith("...")).toBe(true);
    expect(summary).not.toMatch(/wor\.\.\.$/);
  });

  it("keeps the first line when it is not the title", () => {
    expect(briefSummary("Other", "First line\nSecond")).toBe("First line Second");
  });
});

describe("mrTitle", () => {
  it("starts with the task id", () => {
    expect(mrTitle("ACM-12", "Add invoices")).toBe("ACM-12: Add invoices");
  });
});
