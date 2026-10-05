import { describe, expect, it } from "vitest";
import { viewerKindOfPath } from "./media.ts";

describe("viewerKindOfPath", () => {
  it("keeps pages and svg out of the app: they are sandboxed", () => {
    expect(viewerKindOfPath("media/report.html")).toBe("page");
    expect(viewerKindOfPath("drawing.svg")).toBe("page");
  });
});
