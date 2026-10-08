import { describe, expect, it } from "vitest";
import { adminTools } from "./tools.ts";

describe("admin tool schemas", () => {
  it("never repeat a required field, so a client keeps every tool", () => {
    const bad = adminTools()
      .filter((t) => new Set(t.inputSchema.required ?? []).size !== (t.inputSchema.required ?? []).length)
      .map((t) => t.name);
    expect(bad).toEqual([]);
  });

  it("require only fields they define", () => {
    const bad = adminTools()
      .filter((t) => (t.inputSchema.required ?? []).some((k) => !(k in t.inputSchema.properties)))
      .map((t) => t.name);
    expect(bad).toEqual([]);
  });
});
