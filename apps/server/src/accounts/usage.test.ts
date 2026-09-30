import type { AccountUsage, HealthCheck } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failedHealth, OK_HEALTH } from "../testing/fakeRuntime.ts";
import { type Harness, harness } from "../testing/harness.ts";
import { statusFromHealthAndUsage } from "./status.ts";

let h: Harness;
afterEach(async () => {
  vi.useRealTimers();
  await h?.cleanup();
});

const usage = (five: number, week: number): AccountUsage => ({
  plan: "max",
  window: { usedPct: five, resetsAt: "2026-09-29T20:00:00.000Z" },
  weekly: { usedPct: week, resetsAt: "2026-10-03T00:00:00.000Z" },
  models: [],
  estimated: false,
  updatedAt: "2026-09-29T15:00:00.000Z",
});

async function withAccount(auth: "login" | "api-key" = "login") {
  h = await harness();
  await h.cmd("orgs.create", { id: "acme", name: "Acme" });
  const created = await h.cmd("accounts.create", {
    id: "claude-acme",
    tool: "claude",
    org: "acme",
    auth,
    ...(auth === "api-key" ? { apiKey: "sk-test-fake-0000" } : {}),
  });
  expect(created.status).toBe(200);
}

describe("statusFromHealthAndUsage", () => {
  const status = (health: HealthCheck | undefined, u?: AccountUsage) => statusFromHealthAndUsage(health, u);

  it("is at-limit when a window is full and running-high from 80 percent", () => {
    expect(status(OK_HEALTH, usage(100, 10))).toBe("at-limit");
    expect(status(OK_HEALTH, usage(10, 100))).toBe("at-limit");
    expect(status(OK_HEALTH, usage(80, 10))).toBe("running-high");
    expect(status(OK_HEALTH, usage(10, 99))).toBe("running-high");
    expect(status(OK_HEALTH, usage(79, 79))).toBe("healthy");
  });

  it("lets health decide when the account is not healthy or has no usage", () => {
    expect(status(OK_HEALTH)).toBe("healthy");
    expect(status(undefined, usage(100, 100))).toBe("unknown");
    expect(status(failedHealth("auth"), usage(100, 100))).toBe("needs-login");
    expect(status(failedHealth("cli"), usage(90, 90))).toBe("unreachable");
  });

  it("ignores per-model windows", () => {
    const u = { ...usage(10, 10), models: [{ label: "Opus", usedPct: 100 }] };
    expect(status(OK_HEALTH, u)).toBe("healthy");
  });
});

describe("accounts.usage", () => {
  it("reads once, then answers from the cache until refresh is set", async () => {
    await withAccount();
    h.runtime.usage = usage(42, 18);
    const first = await h.cmd("accounts.usage", { id: "claude-acme" });
    expect(first.body).toMatchObject({ plan: "max", window: { usedPct: 42 }, weekly: { usedPct: 18 } });
    await h.cmd("accounts.usage", { id: "claude-acme" });
    expect(h.runtime.usageReads).toHaveLength(1);

    h.runtime.usage = usage(50, 20);
    const refreshed = await h.cmd("accounts.usage", { id: "claude-acme", refresh: true });
    expect(refreshed.body.window.usedPct).toBe(50);
    expect(h.runtime.usageReads).toHaveLength(2);
  });
});

describe("usage and health", () => {
  it("keeps the last numbers and the healthy status when a read fails", async () => {
    await withAccount();
    h.runtime.usage = usage(42, 18);
    await h.cmd("accounts.health", { id: "claude-acme" });
    // The check starts a background read; wait for it to land before the next one.
    await vi.waitFor(async () => {
      expect((await h.cmd("accounts.list")).body[0].usage?.window?.usedPct).toBe(42);
    });

    h.runtime.usage = new Error("Timed out after 30s");
    const res = await h.cmd("accounts.usage", { id: "claude-acme", refresh: true });
    expect(res.body).toMatchObject({
      window: { usedPct: 42 },
      weekly: { usedPct: 18 },
      error: "Timed out after 30s",
    });
    const [account] = (await h.cmd("accounts.list")).body;
    expect(account.status).toBe("healthy");
    expect(account.usage.error).toBe("Timed out after 30s");

    h.runtime.usage = usage(43, 18);
    const fixed = await h.cmd("accounts.usage", { id: "claude-acme", refresh: true });
    expect(fixed.body.error).toBeUndefined();
    expect(fixed.body.window.usedPct).toBe(43);
  });
});
