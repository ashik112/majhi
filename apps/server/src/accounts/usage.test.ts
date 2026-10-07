import type { AccountUsage, HealthCheck } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OK_HEALTH } from "../testing/fakeRuntime.ts";
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

async function _withAccount(auth: "login" | "api-key" = "login") {
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
});
