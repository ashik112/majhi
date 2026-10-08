import { WatchConditionSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { textBreach } from "./engine.ts";

describe("text conditions", () => {
  it("contains breaches only when the text is there", () => {
    expect(textBreach("contains", "down", { text: "Service DOWN", display: "" })).toBe(true);
    expect(textBreach("contains", "down", { text: "all good", display: "" })).toBe(false);
  });

  it("notContains breaches only when the text is missing", () => {
    expect(textBreach("notContains", "ok", { text: "status ok", display: "" })).toBe(false);
    expect(textBreach("notContains", "ok", { text: "failing", display: "" })).toBe(true);
  });

  it("compares a numeric expected value as text", () => {
    const parsed = WatchConditionSchema.parse({ type: "contains", text: 401 });
    expect(parsed).toEqual({ type: "contains", text: "401" });
    expect(textBreach("contains", "401", { number: 401, display: "" })).toBe(true);
    expect(textBreach("notContains", "401", { text: '{"status":401}', display: "" })).toBe(false);
  });
});
