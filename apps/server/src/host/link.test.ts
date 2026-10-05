import type { HostInfo } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostLink, HostOfflineError } from "./link.ts";

const INFO: HostInfo = { version: "1.0.0", platform: "darwin", canRemount: true };

describe("HostLink", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands a queued job to the next poll and resolves the call with the checked reply", async () => {
    const link = new HostLink({ pollTimeoutMs: 1_000 });
    // A first, empty poll makes the helper count as connected.
    const idle = link.poll(INFO);
    const call = link.call("suggestRoots", {});
    const job = await idle;
    expect(job).toMatchObject({ method: "suggestRoots", params: {} });

    const suggestions = [{ path: "/Users/a/Work", repoCount: 3 }];
    expect(link.reply({ id: job?.id ?? "", ok: true, result: { suggestions } })).toBe(true);
    await expect(call).resolves.toEqual({ suggestions });
  });

  it("rejects at once with HostOfflineError when no helper has polled", async () => {
    const link = new HostLink();
    await expect(link.call("suggestRoots", {})).rejects.toBeInstanceOf(HostOfflineError);
  });

  it("rejects with HostOfflineError when the helper takes a job but never answers", async () => {
    vi.useFakeTimers();
    const link = new HostLink();
    const poll = link.poll(INFO);
    const call = link.call("suggestRoots", {}, 10_000);
    const job = await poll;
    const outcome = expect(call).rejects.toEqual(
      new HostOfflineError("The host helper did not answer within 10 seconds."),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    // The late reply finds nobody waiting.
    expect(link.reply({ id: job?.id ?? "", ok: true, result: { suggestions: [] } })).toBe(false);
  });
});
