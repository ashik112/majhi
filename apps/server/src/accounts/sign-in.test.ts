import { SignInExpired } from "@majhi/acp";
import type { AccountUsage } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";

/**
 * The incident behind these: Claude Code's `auth status` says "logged in" with an OAuth token that
 * expired and cannot be refreshed, so every check passed while every run failed on auth.
 */
let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const usage: AccountUsage = {
  plan: "max",
  window: { usedPct: 10 },
  weekly: { usedPct: 20 },
  models: [],
  estimated: false,
  updatedAt: "2026-10-03T00:00:00.000Z",
};

async function withAccount() {
  h = await harness();
  await h.cmd("orgs.create", { id: "acme", name: "Acme" });
  await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
}

const status = async () => (await h.cmd("accounts.list")).body[0].status as string;
/** A check now, not one under 30 seconds old. */
const check = (id = "claude-acme") => h.majhi.services.accounts.health(id, true);

describe("the sign-in check", () => {
  it("fails a check whose usage read finds the token dead, though the CLI says signed in", async () => {
    await withAccount();
    h.runtime.usage = new SignInExpired();
    const res = await check();
    expect(res.account.status).toBe("needs-login");
    const auth = res.health.steps.find((s) => s.name === "auth");
    expect(auth?.ok).toBe(false);
    expect(auth?.detail).toContain("could not be refreshed");

    h.runtime.usage = usage;
    expect((await check()).account.status).toBe("healthy");
  });

  it("marks the account when the background usage read finds the token dead", async () => {
    await withAccount();
    h.runtime.usage = usage;
    await check();
    expect(await status()).toBe("healthy");
    h.runtime.usage = new SignInExpired();
    await h.cmd("accounts.usage", { id: "claude-acme", refresh: true });
    expect(await status()).toBe("needs-login");
  });

  it("keeps an account a run found signed out until a read proves the sign-in works", async () => {
    await withAccount();
    h.runtime.usage = usage;
    await check();
    const accounts = h.majhi.services.accounts;
    expect(await accounts.markSignedOut("claude-acme", "Failed to authenticate")).toBe(true);
    expect(await accounts.markSignedOut("claude-acme", "Failed to authenticate")).toBe(false);
    expect(await status()).toBe("needs-login");

    // A read that fails for another reason proves nothing.
    h.runtime.usage = new Error("Timed out after 30s");
    expect((await check()).account.status).toBe("needs-login");
    h.runtime.usage = usage;
    expect((await check()).account.status).toBe("healthy");
    expect(await accounts.needsLogin("claude-acme")).toBe(false);
  });
});
