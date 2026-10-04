import type { AccountUsage } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";
import { limitFor, statusFromHealthAndUsage } from "./status.ts";

const NOW = new Date("2026-10-03T12:00:00Z");
const MIN = 60_000;

const usage = (window: number, weekly: number, resets = {}): AccountUsage => ({
  window: { usedPct: window, resetsAt: "2026-10-03T15:00:00.000Z" },
  weekly: { usedPct: weekly, resetsAt: "2026-10-07T00:00:00.000Z" },
  models: [],
  estimated: false,
  updatedAt: NOW.toISOString(),
  ...resets,
});

describe("limitFor", () => {
  it("takes the error's reset", () => {
    expect(limitFor({ detail: "x", resetsAt: "2026-10-03T13:00:00.000Z" }, usage(100, 10), NOW)).toEqual({
      since: NOW.toISOString(),
      until: "2026-10-03T13:00:00.000Z",
      resetKnown: true,
      detail: "x",
    });
  });

  it("else the reset of the full window, the later one when both are full", () => {
    expect(limitFor({ detail: "x" }, usage(100, 10), NOW).until).toBe("2026-10-03T15:00:00.000Z");
    expect(limitFor({ detail: "x" }, usage(100, 100), NOW).until).toBe("2026-10-07T00:00:00.000Z");
    expect(limitFor({ detail: "x" }, usage(100, 10), NOW).resetKnown).toBe(false);
  });

  it("else 15 minutes", () => {
    const guess = new Date(NOW.getTime() + 15 * MIN).toISOString();
    expect(limitFor({ detail: "x" }, usage(40, 10), NOW).until).toBe(guess);
    expect(limitFor({ detail: "x" }, undefined, NOW).until).toBe(guess);
  });

  it("keeps the end of a mark that holds when a second error names no reset", () => {
    const first = limitFor({ detail: "a", resetsAt: "2026-10-03T14:00:00.000Z" }, undefined, NOW);
    const later = new Date(NOW.getTime() + 5 * MIN);
    const second = limitFor({ detail: "b" }, undefined, later, first);
    expect(second.until).toBe(first.until);
    expect(second.since).toBe(first.since);
    expect(second.resetKnown).toBe(true);
  });
});

describe("status", () => {
  const health = { ok: true, checkedAt: NOW.toISOString(), durationMs: 1, steps: [] };
  const limit = {
    since: NOW.toISOString(),
    until: "2026-10-03T13:00:00.000Z",
    resetKnown: true,
    detail: "x",
  };

  it("is at-limit while the mark holds, and the usage decides after", () => {
    expect(statusFromHealthAndUsage(health, usage(10, 10), limit, NOW)).toBe("at-limit");
    expect(statusFromHealthAndUsage(health, usage(10, 10), limit, new Date("2026-10-03T13:00:00Z"))).toBe(
      "healthy",
    );
  });
});

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("the limit mark on an account", () => {
  it("shows in the view, survives a health check, and clears once its time passes", async () => {
    let now = NOW;
    h = await harness({ runClock: () => now });
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    const accounts = h.majhi.services.accounts;
    const view = async () => (await h.cmd("accounts.list")).body[0];

    await accounts.health("claude-acme", true);
    expect((await view()).status).toBe("healthy");
    await accounts.markLimit("claude-acme", {
      detail: "You've hit your limit",
      resetsAt: "2026-10-03T13:00:00.000Z",
    });
    expect((await view()).status).toBe("at-limit");
    expect((await view()).limit.until).toBe("2026-10-03T13:00:00.000Z");

    await accounts.health("claude-acme", true);
    expect((await view()).status).toBe("at-limit");

    now = new Date("2026-10-03T13:00:01Z");
    expect((await view()).status).toBe("healthy");
    expect((await view()).limit).toBeUndefined();
    expect(await accounts.limitOf("claude-acme")).toBeUndefined();
    expect(await accounts.expireLimits()).toEqual(["claude-acme"]);
    expect(await accounts.expireLimits()).toEqual([]);
  });
});
