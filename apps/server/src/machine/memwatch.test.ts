import { describe, expect, it } from "vitest";
import { HOT_MEMORY_TEXT, noteHotContainers } from "./memwatch.ts";

describe("hot memory warning", () => {
  it("is one line per task and level, however many containers or readings reach the bar", () => {
    const lines = new Map<string, string>();
    const post = (_task: string, id: string, text: string) => void lines.set(id, text);
    const rows =
      "majhi-run-check-a\tACM-1\nmajhi-run-check-b\tACM-1\nmajhi-run-0123456789ab\tACM-2\nmajhi-run-x\t";
    const args = {
      hot: ["majhi-run-check-a", "majhi-run-check-b", "majhi-run-0123456789ab", "majhi-run-x"],
      rows,
      taskExists: (task: string) => task !== "ACM-9",
      post,
    };
    noteHotContainers(args);
    noteHotContainers(args);
    expect([...lines.keys()].sort()).toEqual(["memory:ACM-1:hot", "memory:ACM-2:hot"]);
    expect(lines.get("memory:ACM-1:hot")).toBe(HOT_MEMORY_TEXT);
  });
});
