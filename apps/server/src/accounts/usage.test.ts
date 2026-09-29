import type { AccountConfig, AccountUsage, HealthCheck } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failedHealth, OK_HEALTH } from "../testing/fakeRuntime.ts";
import { type Harness, harness } from "../testing/harness.ts";
import { statusFromHealthAndUsage } from "./status.ts";
import { type AccountUsageReader, UsageSweeper } from "./usage.ts";

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

  it("is null for API-key accounts and never reads", async () => {
    await withAccount("api-key");
    h.runtime.usage = usage(42, 18);
    const res = await h.cmd("accounts.usage", { id: "claude-acme", refresh: true });
    expect(res.body).toBeNull();
    expect(h.runtime.usageReads).toHaveLength(0);
  });

  it("answers 404 for an unknown account", async () => {
    await withAccount();
    expect((await h.cmd("accounts.usage", { id: "nope" })).status).toBe(404);
  });

  it("survives a restart through the cache file", async () => {
    await withAccount();
    h.runtime.usage = usage(42, 18);
    await h.cmd("accounts.usage", { id: "claude-acme" });
    const again = h.restart();
    const list = await again.cmd("accounts.list");
    expect(list.body[0].usage).toMatchObject({ window: { usedPct: 42 } });
  });
});

describe("usage and health", () => {
  it("reads usage after a passing health check, and the list shows it with the status", async () => {
    await withAccount();
    h.runtime.usage = usage(85, 20);
    await h.cmd("accounts.health", { id: "claude-acme" });
    await vi.waitFor(() => expect(h.runtime.usageReads).toHaveLength(1));
    await vi.waitFor(async () => {
      const [account] = (await h.cmd("accounts.list")).body;
      expect(account.status).toBe("running-high");
      expect(account.usage.window.usedPct).toBe(85);
    });
  });

  it("does not read usage when the check fails", async () => {
    await withAccount();
    h.runtime.probe = { health: failedHealth("auth") };
    await h.cmd("accounts.health", { id: "claude-acme" });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.runtime.usageReads).toHaveLength(0);
  });

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

  it("records an error even when there were never any numbers", async () => {
    await withAccount();
    h.runtime.usage = new Error("no plan limits");
    const res = await h.cmd("accounts.usage", { id: "claude-acme" });
    expect(res.body).toMatchObject({ error: "no plan limits", models: [] });
    expect(res.body.window).toBeUndefined();
  });

  it("emits an accounts event only when the numbers or the error change", async () => {
    await withAccount();
    const events: unknown[] = [];
    h.majhi.services.events.subscribe((e) => events.push(e));
    h.runtime.usage = usage(42, 18);
    await h.cmd("accounts.usage", { id: "claude-acme", refresh: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "changed", topics: ["accounts"] });

    h.runtime.usage = { ...usage(42, 18), updatedAt: "2026-09-29T16:00:00.000Z" };
    await h.cmd("accounts.usage", { id: "claude-acme", refresh: true });
    expect(events).toHaveLength(1);

    h.runtime.usage = usage(43, 18);
    await h.cmd("accounts.usage", { id: "claude-acme", refresh: true });
    expect(events).toHaveLength(2);
  });
});

describe("usageCandidates", () => {
  it("lists login accounts whose last check passed", async () => {
    await withAccount();
    await h.cmd("accounts.create", {
      id: "claude-key",
      tool: "claude",
      org: "acme",
      auth: "api-key",
      apiKey: "sk-test-fake-0000",
    });
    await h.cmd("accounts.create", { id: "codex-acme", tool: "codex", org: "acme", auth: "login" });
    expect(await h.majhi.services.accounts.usageCandidates()).toEqual([]);

    await h.cmd("accounts.health", { id: "claude-acme" });
    await h.cmd("accounts.health", { id: "claude-key" });
    h.runtime.probe = { health: failedHealth("auth") };
    await h.cmd("accounts.health", { id: "codex-acme" });
    expect((await h.majhi.services.accounts.usageCandidates()).map((c) => c.id)).toEqual(["claude-acme"]);
  });
});

describe("UsageSweeper", () => {
  const login: AccountConfig = { tool: "claude", org: "acme", auth: "login" };

  function setup() {
    const read = vi.fn<(id: string, config: AccountConfig) => Promise<AccountUsage | null>>();
    read.mockResolvedValue(null);
    const reader = { read } as unknown as AccountUsageReader;
    const candidates = vi.fn(async () => [
      { id: "a", config: login },
      { id: "b", config: login },
    ]);
    return { read, sweeper: new UsageSweeper({ reader, candidates, intervalMs: 600_000 }) };
  }

  it("sweeps at start and then every 10 minutes, one account at a time", async () => {
    vi.useFakeTimers();
    const { read, sweeper } = setup();
    sweeper.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);

    await vi.advanceTimersByTimeAsync(599_000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(4);
    sweeper.stop();
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("skips a sweep while the previous one still runs", async () => {
    vi.useFakeTimers();
    const { read, sweeper } = setup();
    let release: () => void = () => {};
    read.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(null))));
    sweeper.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await sweeper.sweep()).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    sweeper.stop();
  });
});
