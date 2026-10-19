import { AutonomySettingsSchema, type CommandName } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type AutonomyCall, decideAutonomously, type PolicyContext } from "./policy.ts";

const settings = AutonomySettingsSchema.parse({
  orgs: {
    acme: { level: "routine" },
    globex: { level: "full" },
    northwind: { level: "ask" },
  },
});

function call(command: CommandName, input: Record<string, unknown> = {}, extra: Partial<AutonomyCall> = {}) {
  return { command, input, org: "acme", confirm: false, ...extra };
}

function ctx(extra: Partial<PolicyContext> = {}): PolicyContext {
  return { settings, holds: [], accounts: [], ...extra };
}

const decide = (c: AutonomyCall, x: PolicyContext = ctx()) => decideAutonomously(c, x).decision;

describe("decideAutonomously: the authority level", () => {
  const at = (level: "ask" | "routine" | "full"): PolicyContext =>
    ctx({ settings: AutonomySettingsSchema.parse({ orgs: { acme: { level } } }) });

  it.each<[command: CommandName, ask: string, routine: string, full: string]>([
    ["tasks.start", "left", "approved", "approved"],
    ["tasks.push", "left", "approved", "approved"],
    ["tasks.openMrs", "left", "approved", "approved"],
    ["tasks.merge", "left", "left", "approved"],
  ])(
    "%s: the captain's decision at Ask me is %s, at Routine %s, at Full %s",
    (command, ask, routine, full) => {
      const call_ = call(command, { id: "ACM-1" });
      expect(decide(call_, at("ask"))).toBe(ask);
      expect(decide(call_, at("routine"))).toBe(routine);
      expect(decide(call_, at("full"))).toBe(full);
    },
  );
});
