import { describe, expect, it } from "vitest";
import { effectiveCommands, substituteBase } from "./commands.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("effectiveCommands", () => {
  const card = { test: "vitest run", build: "pnpm build", lint: "pnpm lint" };

  it("lets the project's override win over the card, command by command", () => {
    const out = effectiveCommands(card, { test: "vitest run --changed {base}", typecheck: "pnpm tc" });
    expect(out).toEqual({
      test: "vitest run --changed {base}",
      build: "pnpm build",
      lint: "pnpm lint",
      typecheck: "pnpm tc",
    });
  });

  it("is the card alone when the project has no override", () => {
    expect(effectiveCommands(card, undefined)).toEqual(card);
    expect(effectiveCommands(undefined, undefined)).toEqual({});
  });
});

describe("substituteBase", () => {
  it("leaves a command without the placeholder as it was", () => {
    expect(substituteBase("pnpm test", undefined)).toEqual({ command: "pnpm test" });
  });

  it("puts the computed sha in, and nothing else", () => {
    expect(substituteBase("vitest run --changed {base} --passWithNoTests", SHA)).toEqual({
      command: `vitest run --changed ${SHA} --passWithNoTests`,
    });
  });

  it("refuses a base that is not a full hex sha", () => {
    const bad = [
      undefined,
      "",
      "main",
      SHA.slice(0, 12),
      SHA.toUpperCase(),
      `${SHA}; rm -rf /`,
      "$(whoami)",
      `${SHA}\n`,
    ];
    for (const base of bad) {
      expect(substituteBase("vitest run --changed {base}", base)).toHaveProperty("error");
    }
  });
});
