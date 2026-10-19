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

  it.each([
    ["auto", true, "run"],
    ["auto", false, "run"],
    ["when-asked", true, "run"],
    ["when-asked", false, "pending"],
    ["confirm", true, "pending"],
    ["confirm", false, "pending"],
  ] as const)("%s with ownerAsked=%s is %s", (mode, asked, expected) => {
    expect(decide(mode, asked)).toBe(expected);
  });
});

describe("redact", () => {
  it("hides secret-looking fields and strings, keeps the rest and references", () => {
    const out = redact({
      id: "claude-x",
      apiKey: "abc",
      value: "hunter2",
      note: `use sk-ant-api03-${"aB3xY9".repeat(8)} please`,
      key: "secret:claude-x",
      nested: { passphrase: "pw", name: "Acme" },
      list: [{ token: "t" }, "plain"],
      empty: "",
    });
    expect(out).toEqual({
      id: "claude-x",
      apiKey: "[redacted]",
      value: "[redacted]",
      note: "use [redacted] please",
      key: "secret:claude-x",
      nested: { passphrase: "[redacted]", name: "Acme" },
      list: [{ token: "[redacted]" }, "plain"],
      empty: "",
    });
  });

  it("keeps counts and flags under secret-looking names, but never text", () => {
    expect(redact({ inputTokens: 1200, cacheReadTokens: 0, tokenSet: true, tokens: "abc" })).toEqual({
      inputTokens: 1200,
      cacheReadTokens: 0,
      tokenSet: true,
      tokens: "[redacted]",
    });
  });

  it("redacts text", () => {
    expect(redactText(`AKIAIOSFODNN7EXAMPLE`)).toBe("[redacted]");
  });
});

describe("isDestructiveCommand", () => {
  it.each([
    ["agents.remove", true],
    ["policy.set", true],
    ["team.remove", false],
    ["tasks.removeAgent", false],
    ["projects.remove", false],
    ["watch.remove", false],
    ["secrets.remove", true],
    ["connections.remove", true],
    ["memory.forget", true],
    ["things.deleteAll", false],
    ["orgs.create", false],
    ["tasks.merge", false],
    ["tasks.terminal.open", false],
  ])("%s is %s", (name, expected) => {
    expect(isDestructiveCommand(name)).toBe(expected);
  });
});

describe("what the captain sees of a command's answer", () => {
  it("keeps a reading's value and still hides tokens and passwords", async () => {
    const { redactOutput } = await import("./policy.ts");
    expect(redactOutput({ ok: true, value: "42", number: 42 })).toEqual({
      ok: true,
      value: "42",
      number: 42,
    });
    expect(redactOutput({ token: "abc123secret", password: "hunter22", value: "55%" })).toEqual({
      token: "[redacted]",
      password: "[redacted]",
      value: "55%",
    });
  });
});
