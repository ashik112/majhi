import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";
import { limitFor } from "./status.ts";

const NOW = new Date("2026-10-03T12:00:00Z");
const MIN = 60_000;

describe("limitFor", () => {
  it("keeps the end of a mark that holds when a second error names no reset", () => {
    const first = limitFor({ detail: "a", resetsAt: "2026-10-03T14:00:00.000Z" }, undefined, NOW);
    const later = new Date(NOW.getTime() + 5 * MIN);
    const second = limitFor({ detail: "b" }, undefined, later, first);
    expect(second.until).toBe(first.until);
    expect(second.since).toBe(first.since);
    expect(second.resetKnown).toBe(true);
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
