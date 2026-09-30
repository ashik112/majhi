import { describe, expect, it } from "vitest";
import { httpProbe, looksLikeNetworkError, looksLikeOverload, NetworkWatch } from "./network.ts";
import { wakePlan } from "./wake.ts";

describe("offline detection", () => {
  it("goes offline only when the probe fails twice, and online on the first success", async () => {
    const answers: boolean[] = [];
    const changes: boolean[] = [];
    const watch = new NetworkWatch({
      probe: async () => answers.shift() ?? true,
      onChange: (o) => changes.push(o),
    });
    answers.push(false, true);
    expect(await watch.check()).toBe(true);
    expect(changes).toEqual([]);
    answers.push(false, false);
    expect(await watch.check()).toBe(false);
    expect(watch.online).toBe(false);
    answers.push(false, false);
    await watch.check();
    expect(changes).toEqual([false]);
    answers.push(true);
    await watch.check();
    expect(changes).toEqual([false, true]);
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
