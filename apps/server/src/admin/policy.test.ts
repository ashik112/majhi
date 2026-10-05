import { type AllowRule, effectiveMode, isDestructiveCommand, PolicySettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { decide, matchRule, redact, redactText } from "./policy.ts";

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

describe("matchRule", () => {
  const call = { agent: "acme-builder", command: "tasks.merge", task: "ACM-1", org: "acme" };
  const taskRule = { agent: "acme-builder", command: "tasks.merge", task: "ACM-1" };
  const orgRule = { agent: "acme-builder", command: "tasks.merge", org: "acme" };
  const policy = (rules: AllowRule[], allowDestructive = false) =>
    PolicySettingsSchema.parse({ rules, allow_destructive_rules: allowDestructive });

  it("needs the same agent and command", () => {
    expect(matchRule(policy([taskRule]), call)).toEqual(taskRule);
    expect(matchRule(policy([taskRule]), { ...call, agent: "boss" })).toBeUndefined();
    expect(matchRule(policy([taskRule]), { ...call, command: "tasks.split" })).toBeUndefined();
    expect(matchRule(policy([]), call)).toBeUndefined();
  });

  it("covers a task rule's own task only", () => {
    expect(matchRule(policy([taskRule]), { ...call, task: "ACM-2" })).toBeUndefined();
    expect(matchRule(policy([taskRule]), { ...call, task: "GLX-1", org: "globex" })).toBeUndefined();
  });

  it("covers every task of an org rule's org, and no other org or LOCAL task", () => {
    expect(matchRule(policy([orgRule]), { ...call, task: "ACM-9" })).toEqual(orgRule);
    expect(matchRule(policy([orgRule]), { ...call, task: "GLX-1", org: "globex" })).toBeUndefined();
    expect(matchRule(policy([orgRule]), { ...call, task: "LOCAL-1", org: undefined })).toBeUndefined();
  });

  it("never covers a destructive command, even with the old toggle on", () => {
    const rule = { agent: "acme-builder", command: "agents.remove", org: "acme" };
    const remove = { ...call, command: "agents.remove" };
    expect(matchRule(policy([rule]), remove)).toBeUndefined();
    expect(matchRule(policy([rule], true), remove)).toBeUndefined();
    const soft = { agent: "acme-builder", command: "tasks.remove", task: "ACM-1" };
    expect(matchRule(policy([soft], true), { ...call, command: "tasks.remove" })).toBeUndefined();
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
