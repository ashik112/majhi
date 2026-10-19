import { effectiveMode, isDestructiveCommand, PolicySettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { decide, redact, redactText } from "./policy.ts";

describe("approval decision table", () => {
  it("keeps a destructive command on confirm whatever the policy says", () => {
    const policy = PolicySettingsSchema.parse({
      destructive: "auto",
      commands: { "agents.remove": "auto", "team.remove": "auto" },
    });
    expect(effectiveMode(policy, "agents.remove", "destructive")).toBe("confirm");
    // Removing a setting is a plain change: the policy decides it.
    expect(effectiveMode(policy, "team.remove", "change")).toBe("auto");
  });
});
