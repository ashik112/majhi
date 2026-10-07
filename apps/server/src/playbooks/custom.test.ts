import { CUSTOM_MAX_TOKENS } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { parsePlan } from "./custom.ts";

/** A sentence-planned playbook is a checked spec: no owner-only outputs, a small budget, off until turned on. */

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "Client updates",
    pack: "business",
    purpose: "Draft a weekly update.",
    cadence: { kind: "weekly", day: 1, at: "09:00" },
    steps: "Draft one.",
    outputs: ["draft"],
    tokens: 2000,
    plan: "Every Monday I draft an update.",
    ...over,
  });

describe("parsePlan", () => {
  it("drops outputs a made playbook may not have and clamps the budget", () => {
    const r = parsePlan(reply({ outputs: ["task", "decision", "draft", "shell"], tokens: 900_000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.outputs).toEqual(["draft"]);
    expect(r.value.spec.tokens).toBe(CUSTOM_MAX_TOKENS);
  });

  it("never schedules more often than hourly", () => {
    const r = parsePlan(reply({ cadence: { kind: "every", minutes: 5 } }));
    expect(r.ok && r.value.spec.cadence).toEqual({ kind: "every", minutes: 60 });
  });
});
