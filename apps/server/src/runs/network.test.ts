import { describe, expect, it } from "vitest";
import { httpProbe, looksLikeNetworkError, looksLikeOverload, NetworkWatch } from "./network.ts";
import { wakePlan } from "./wake.ts";

describe("offline detection", () => {
  it("goes offline only after the probe failed for 45 seconds, and online on the first success", async () => {
    let now = 0;
    let up = true;
    let probes = 0;
    const changes: boolean[] = [];
    let stillOffline = 0;
    const watch = new NetworkWatch({
      probe: async () => {
        probes++;
        return up;
      },
      onChange: (o) => changes.push(o),
      onStillOffline: () => stillOffline++,
      now: () => now,
    });
    expect(watch.online).toBe(true);
    // One probe tries twice, so a single dropped packet is not a failure.
    up = false;
    expect(await watch.check()).toBe(false);
    expect(probes).toBe(2);
    // A blip: failing at 0, 15 and 30 s, then working. Never offline, but runs paused by a
    // network error hear that the connection works.
    for (const at of [15_000, 30_000]) {
      now = at;
      await watch.check();
    }
    expect(watch.online).toBe(true);
    expect(changes).toEqual([]);
    up = true;
    now = 40_000;
    expect(await watch.check()).toBe(true);
    expect(changes).toEqual([true]);
    await watch.check();
    expect(changes).toEqual([true]);

    // A real outage: offline once the probe failed for 45 s, from the first failed probe.
    up = false;
    for (const at of [100_000, 115_000, 130_000]) {
      now = at;
      await watch.check();
    }
    expect(changes).toEqual([true]);
    now = 145_000;
    await watch.check();
    expect(watch.online).toBe(false);
    expect(changes).toEqual([true, false]);
    now = 160_000;
    await watch.check();
    expect(stillOffline).toBe(1);
    expect(changes).toEqual([true, false]);
    up = true;
    now = 175_000;
    await watch.check();
    expect(watch.online).toBe(true);
    expect(changes).toEqual([true, false, true]);
  });

  it("scales the outage window with the probe interval", async () => {
    let now = 0;
    const changes: boolean[] = [];
    const watch = new NetworkWatch({
      probe: async () => false,
      onChange: (o) => changes.push(o),
      intervalMs: 500,
      now: () => now,
    });
    await watch.check();
    now = 1_000;
    await watch.check();
    expect(changes).toEqual([]);
    now = 1_500;
    await watch.check();
    expect(changes).toEqual([false]);
  });

  it("counts a throwing probe as a failure", async () => {
    const watch = new NetworkWatch({
      probe: async () => {
        throw new Error("boom");
      },
      onChange: () => {},
    });
    expect(await watch.check()).toBe(false);
  });

  it("treats any HTTP answer as online and a failed connection as offline", async () => {
    const hosts: string[] = [];
    const answering = httpProbe(["https://a", "https://b"], (async (url: string) => {
      hosts.push(url);
      if (url === "https://a") throw new TypeError("fetch failed");
      return new Response(null, { status: 404 });
    }) as typeof fetch);
    expect(await answering()).toBe(true);
    expect(hosts).toEqual(["https://a", "https://b"]);
    const dead = httpProbe(["https://a"], (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(await dead()).toBe(false);
  });

  it("retries an overloaded API, but not a usage limit", () => {
    expect(
      looksLikeOverload(
        "Internal error: API Error: 529 Overloaded. This is a server-side issue, usually temporary",
      ),
    ).toBe(true);
    expect(looksLikeOverload("API Error: 503 Service Unavailable")).toBe(true);
    expect(looksLikeOverload("API Error: 429 rate_limit_error")).toBe(false);
    expect(looksLikeOverload("Claude usage limit reached. Your limit resets at 3pm")).toBe(false);
    expect(looksLikeOverload("Tool failed: file not found")).toBe(false);
  });

  it("tells network failures from agent errors", () => {
    expect(looksLikeNetworkError("getaddrinfo ENOTFOUND api.anthropic.com")).toBe(true);
    expect(looksLikeNetworkError("API Error: Connection error.")).toBe(true);
    expect(looksLikeNetworkError("fetch failed")).toBe(true);
    expect(looksLikeNetworkError("Unknown model: sonnet")).toBe(false);
    expect(looksLikeNetworkError("prompt is too long")).toBe(false);
  });
});

describe("wake", () => {
  it("resumes cut and retryable turns and restarts open turns that went quiet", () => {
    const now = 1_000_000;
    const plan = wakePlan(
      [
        { key: "cut", turning: false, interrupted: true, retryable: false, lastEventAt: 0 },
        { key: "net", turning: false, interrupted: false, retryable: true, lastEventAt: 0 },
        { key: "idle", turning: false, interrupted: false, retryable: false, lastEventAt: 0 },
        { key: "stalled", turning: true, interrupted: false, retryable: false, lastEventAt: now - 120_000 },
        { key: "live", turning: true, interrupted: false, retryable: false, lastEventAt: now - 1_000 },
      ],
      now,
    );
    expect(plan).toEqual({ resume: ["cut", "net"], restart: ["stalled"] });
  });
});
