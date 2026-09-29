import type { RoomItem } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { fenceFor, fileEditStamp, lineNumbers, looksBinary, viewablePath } from "./model";

const folder = "/tasks/ACM-1";

function tool(id: string, over: Partial<Extract<RoomItem, { type: "tool" }>>): RoomItem {
  return {
    id,
    type: "tool",
    agent: "a",
    toolCallId: id,
    title: "Edit",
    kind: "edit",
    status: "completed",
    locations: [],
    content: [],
    ...over,
  } as RoomItem;
}

describe("fileEditStamp", () => {
  it("is the last completed tool call that touched the file, by location or diff", () => {
    const items = [
      tool("t1", { locations: [`${folder}/MOVES.md`] }),
      tool("t2", { locations: [`${folder}/other.md`] }),
      tool("t3", { content: [{ type: "diff", path: `${folder}/MOVES.md`, newText: "x" }] }),
      tool("t4", { locations: [`${folder}/MOVES.md`], status: "in_progress" }),
    ];
    expect(fileEditStamp(items, folder, "MOVES.md")).toBe("t3");
    expect(fileEditStamp(items, folder, "other.md")).toBe("t2");
    expect(fileEditStamp(items, folder, "missing.md")).toBeUndefined();
  });
});

describe("viewablePath", () => {
  it("opens edited files in the task folder, not deleted or outside ones", () => {
    const wt = `${folder}/api`;
    expect(viewablePath({ path: `${wt}/src/a.ts`, change: "edit" }, wt, folder)).toBe("api/src/a.ts");
    expect(viewablePath({ path: "src/a.ts", change: "edit" }, wt, folder)).toBe("api/src/a.ts");
    expect(viewablePath({ path: "src/a.ts", change: "edit" }, undefined, folder)).toBeUndefined();
    expect(viewablePath({ path: `${wt}/src/a.ts`, change: "delete" }, wt, folder)).toBeUndefined();
    expect(viewablePath({ path: "/etc/hosts", change: "edit" }, wt, folder)).toBeUndefined();
    expect(viewablePath({ path: "../x", change: "edit" }, wt, folder)).toBeUndefined();
  });
});

describe("source helpers", () => {
  it("fences longer than any backtick run inside", () => {
    expect(fenceFor("plain")).toBe("```");
    expect(fenceFor("a ```` b")).toBe("`````");
  });

  it("numbers lines without counting the final newline", () => {
    expect(lineNumbers("")).toBe("1");
    expect(lineNumbers("a")).toBe("1");
    expect(lineNumbers("a\nb\n")).toBe("1\n2");
    expect(lineNumbers("a\n\nc")).toBe("1\n2\n3");
  });

  it("spots binary content", () => {
    expect(looksBinary(new Uint8Array([104, 105]))).toBe(false);
    expect(looksBinary(new Uint8Array([104, 0, 105]))).toBe(true);
  });
});
