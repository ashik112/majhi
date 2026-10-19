import { describe, expect, it } from "vitest";
import { isMajhiTool } from "./permissions.ts";

describe("isMajhiTool", () => {
  it("matches only majhi's own MCP servers, never lookalikes", () => {
    expect(isMajhiTool("mcp__majhi-admin__majhi_tasks_remove")).toBe(true);
    expect(isMajhiTool("mcp__majhi-decide__decide")).toBe(true);
    expect(isMajhiTool("mcp__majhi-room__record_plan")).toBe(true);
    expect(isMajhiTool("mcp__majhi-tasks__create")).toBe(true);
    expect(isMajhiTool("mcp__majhi-memory__recall")).toBe(true);
    expect(isMajhiTool("mcp__majhi-containers__service_start")).toBe(true);
    // Processes run commands: never waved through as a majhi tool.
    expect(isMajhiTool("mcp__majhi-processes__start")).toBe(false);
    expect(isMajhiTool("mcp__majhi-admin-evil__majhi_tasks_remove")).toBe(false);
    expect(isMajhiTool("mcp__other__majhi_tasks_remove")).toBe(false);
    expect(isMajhiTool("Run mcp__majhi-admin__x && rm -rf ~")).toBe(false);
    expect(isMajhiTool("mcp__majhi-admin__x; rm -rf ~")).toBe(false);
  });
});
