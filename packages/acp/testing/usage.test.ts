import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountRuntime, RuntimeOptions } from "../src/index.ts";
import { mapClaudeUsage, mapCodexRateLimits, readUsage } from "../src/index.ts";
import { type FakeAgentOptions, fakeAdapter, fakeUsage } from "./index.ts";

const base = { PATH: process.env.PATH ?? "/usr/bin" };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-usage-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function opts(tool: "claude" | "codex", fake: FakeAgentOptions = {}): RuntimeOptions {
  return {
    base,
    adapters: { [tool]: fakeAdapter(tool, fake) },
    usage: { claude: fakeUsage(fake) },
    timeoutMs: 15_000,
  };
}

const FIVE = "2026-09-29T20:00:00.000Z";
const WEEK = "2026-10-03T00:00:00.000Z";

describe.each(["claude", "codex"] as const)("readUsage with the fake %s adapter", (tool) => {
  const account: AccountRuntime = { tool, home: "" };

  it("maps the 5-hour and weekly windows", async () => {
    const usage = await readUsage(
      { ...account, home: root },
      opts(tool, {
        signedIn: true,
        usage: { fiveHourPct: 42, weekPct: 18, fiveHourResetsAt: FIVE, weekResetsAt: WEEK, plan: "plus" },
      }),
    );
    expect(usage).toMatchObject({
      plan: "plus",
      window: { usedPct: 42, resetsAt: FIVE },
      weekly: { usedPct: 18, resetsAt: WEEK },
      models: [],
      estimated: false,
    });
    expect(Number.isNaN(Date.parse(usage?.updatedAt ?? ""))).toBe(false);
  });

  it("fails when the account is signed out", async () => {
    await expect(readUsage({ ...account, home: root }, opts(tool))).rejects.toThrow(/./);
  });

  it("returns nothing for API-key accounts", async () => {
    expect(await readUsage({ ...account, home: root, apiKey: "sk-test-0000" }, opts(tool))).toBeUndefined();
  });
});

describe("Claude usage", () => {
  it("adds per-model weekly windows", async () => {
    const usage = await readUsage(
      { tool: "claude", home: root },
      opts("claude", { signedIn: true, usage: { opusPct: 30, weekResetsAt: WEEK } }),
    );
    expect(usage?.models).toEqual([{ label: "Opus", usedPct: 30, resetsAt: WEEK }]);
  });

  it("runs the built-in helper script, which fails clearly when the adapter is not installed", async () => {
    const options: RuntimeOptions = {
      base: { PATH: "/nonexistent" },
      adapters: { claude: { command: "no-such-adapter", args: [] } },
      timeoutMs: 15_000,
    };
    await expect(readUsage({ tool: "claude", home: root }, options)).rejects.toThrow(
      "no-such-adapter is not on PATH",
    );
  });

  it("reports a helper that prints something else", () => {
    expect(() => mapClaudeUsage({ nope: true })).toThrow("shape majhi does not know");
  });

  it("reports an account without plan limits", () => {
    expect(() => mapClaudeUsage({ rate_limits_available: false, rate_limits: null })).toThrow(
      "no plan limits",
    );
  });

  it("skips null windows, clamps and keeps unknown fields harmless", () => {
    const usage = mapClaudeUsage({
      subscription_type: null,
      rate_limits_available: true,
      extra: 1,
      rate_limits: {
        five_hour: { utilization: null, resets_at: null },
        seven_day: { utilization: 120, resets_at: WEEK, limit_dollars: null },
        seven_day_sonnet: { utilization: 5, resets_at: null },
        model_scoped: [{ display_name: "Sonnet", utilization: 9, resets_at: WEEK }],
      },
    });
    expect(usage.plan).toBeUndefined();
    expect(usage.window).toBeUndefined();
    expect(usage.weekly).toEqual({ usedPct: 100, resetsAt: WEEK });
    // model_scoped wins over the older seven_day_sonnet field
    expect(usage.models).toEqual([{ label: "Sonnet", usedPct: 9, resetsAt: WEEK }]);
  });
});

describe("Codex usage", () => {
  const snapshot = (primary: object | null, secondary: object | null) => ({
    rateLimits: { primary, secondary, planType: "pro", credits: null },
  });

  it("tells the windows apart by duration, not by slot", () => {
    const usage = mapCodexRateLimits(
      snapshot({ usedPercent: 60, windowDurationMins: 10080, resetsAt: 1790000000 }, null),
    );
    expect(usage.window).toBeUndefined();
    expect(usage.weekly).toEqual({ usedPct: 60, resetsAt: new Date(1790000000 * 1000).toISOString() });
    expect(usage.plan).toBe("pro");
  });

  it("falls back to primary and secondary when durations are missing", () => {
    const usage = mapCodexRateLimits(snapshot({ usedPercent: 1 }, { usedPercent: 2 }));
    expect(usage.window).toEqual({ usedPct: 1 });
    expect(usage.weekly).toEqual({ usedPct: 2 });
  });

  it("rejects a result of another shape", () => {
    expect(() => mapCodexRateLimits({ rateLimits: "x" })).toThrow("shape majhi does not know");
  });

  it("surfaces the app-server error when signed out", async () => {
    await expect(readUsage({ tool: "codex", home: root }, opts("codex"))).rejects.toThrow(
      "authentication required",
    );
  });
});
