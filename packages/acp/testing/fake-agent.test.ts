import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountRuntime, RuntimeOptions } from "../src/index.ts";
import { probeAccount } from "../src/probe.ts";
import { fakeAdapter } from "./index.ts";

const base = { PATH: process.env.PATH ?? "/usr/bin" };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-fake-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function opts(tool: "claude" | "codex", fake: Parameters<typeof fakeAdapter>[1] = {}): RuntimeOptions {
  return { base, adapters: { [tool]: fakeAdapter(tool, fake) }, timeoutMs: 15_000 };
}

describe.each(["claude", "codex"] as const)("probeAccount with the fake %s adapter", (tool) => {
  it("passes every step when signed in", async () => {
    const account: AccountRuntime = { tool, home: root };
    const probe = await probeAccount(
      account,
      opts(tool, { signedIn: true, models: ["m1", "m2", "m3"], efforts: ["low", "high"] }),
    );
    expect(probe.health.ok).toBe(true);
    expect(probe.health.steps.map((s) => [s.name, s.ok])).toEqual([
      ["cli", true],
      ["auth", true],
      ["acp", true],
    ]);
    expect(probe.health.steps[0]?.detail).toContain(tool === "claude" ? "2.1.284" : "0.158.0");
    expect(probe.health.steps[2]?.detail).toBe("3 models");
    expect(probe.health.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(probe.health.checkedAt))).toBe(false);
    expect(probe.models).toMatchObject({
      models: [
        { id: "m1", name: "m1" },
        { id: "m2", name: "m2" },
        { id: "m3", name: "m3" },
      ],
      efforts: [{ id: "low" }, { id: "high" }],
      defaultModel: "m1",
      defaultEffort: "low",
    });
    if (tool === "claude") expect(probe.signedInAs).toBe("fake@example.com");
  });

  it("stops at auth when not signed in", async () => {
    const probe = await probeAccount({ tool, home: root }, opts(tool));
    expect(probe.health.ok).toBe(false);
    expect(probe.health.steps.map((s) => [s.name, s.ok])).toEqual([
      ["cli", true],
      ["auth", false],
    ]);
    expect(probe.health.steps[1]?.detail).toBe("Not signed in. Sign in from Studio > Accounts.");
    expect(probe.models).toBeUndefined();
  });
});
