import { describe, expect, it } from "vitest";
import { taskFileReference, viewerKindOfPath } from "./media.ts";

describe("viewerKindOfPath", () => {
  it("keeps pages and svg out of the app: they are sandboxed", () => {
    expect(viewerKindOfPath("media/report.html")).toBe("page");
    expect(viewerKindOfPath("drawing.svg")).toBe("page");
  });
});

describe("task file references", () => {
  const folder = "/Users/owner/workspace/tasks/PRV-1";
  it("keeps the target task for captain links and sibling file paths", () => {
    expect(taskFileReference("/api/tasks/ACM-2/files/docs/plan.md", folder)).toEqual({
      task: "ACM-2",
      path: "docs/plan.md",
    });
    expect(taskFileReference("file:///Users/owner/workspace/tasks/ACM-2/docs/plan.md", folder)).toEqual({
      task: "ACM-2",
      path: "docs/plan.md",
    });
    expect(taskFileReference("notes.md", folder)).toEqual({ path: "notes.md" });
  });
  it.each([
    "/api/tasks/ACM-2/files/../secret",
    "/api/tasks/ACM-2/files/%2e%2e/secret",
    "/Users/owner/workspace/tasks/ACM-2/../secret",
    "/Users/owner/elsewhere/ACM-2/report.md",
    "/Users/owner/workspace/tasks/not-a-task/report.md",
    "/Users/owner/workspace/tasks/ACM-2/%252e%252e/secret",
  ])("refuses outside paths: %s", (target) => expect(taskFileReference(target, folder)).toBeUndefined());
});
