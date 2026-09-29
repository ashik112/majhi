import { PolicySettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { decide, modeFor, redact, redactText } from "./policy.ts";

const defaults = PolicySettingsSchema.parse({});

describe("approval decision table", () => {
  it("uses the risk class default, and a command override first", () => {
    expect(modeFor(defaults, "orgs.list", "read")).toBe("auto");
    expect(modeFor(defaults, "orgs.create", "change")).toBe("when-asked");
    expect(modeFor(defaults, "agents.remove", "destructive")).toBe("confirm");
    expect(modeFor(defaults, "system.update", "outbound")).toBe("confirm");
    const policy = PolicySettingsSchema.parse({ commands: { "orgs.create": "auto" } });
    expect(modeFor(policy, "orgs.create", "change")).toBe("auto");
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
    expect(redactText("nothing here")).toBe("nothing here");
  });
});
