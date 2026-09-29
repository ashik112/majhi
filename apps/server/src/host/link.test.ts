import type { HostInfo } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostJobError, HostLink, HostOfflineError } from "./link.ts";

const INFO: HostInfo = { version: "1.0.0", platform: "darwin", canRemount: true };

/** A poll whose request is already gone: it takes a queued job or ends at once, and marks the helper connected. */
function quickPoll(link: HostLink) {
  return link.poll(INFO, AbortSignal.abort());
}

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

  it("queues jobs made between polls and delivers them in order", async () => {
    const link = new HostLink();
    await quickPoll(link);
    const first = link.call("listDirs", { path: "/a", showHidden: false });
    const second = link.call("listDirs", { path: "/b", showHidden: true });
    const a = await quickPoll(link);
    const b = await quickPoll(link);
    expect([a?.params, b?.params]).toEqual([
      { path: "/a", showHidden: false },
      { path: "/b", showHidden: true },
    ]);
    link.reply({ id: a?.id ?? "", ok: false, error: "There is no folder at /a" });
    link.reply({ id: b?.id ?? "", ok: true, result: { nope: true } });
    await expect(first).rejects.toEqual(new HostJobError("There is no folder at /a"));
    await expect(second).rejects.toBeInstanceOf(HostJobError);
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

  it("drops a job that timed out before any poll picked it up", async () => {
    vi.useFakeTimers();
    const link = new HostLink();
    await quickPoll(link);
    const outcome = expect(link.call("suggestRoots", {}, 10_000)).rejects.toBeInstanceOf(HostOfflineError);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(await quickPoll(link)).toBeUndefined();
  });

  it("ends an idle poll empty after the poll timeout", async () => {
    vi.useFakeTimers();
    const link = new HostLink({ pollTimeoutMs: 25_000 });
    let ended = false;
    const poll = link.poll(INFO).then((job) => {
      ended = true;
      return job;
    });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await poll).toBeUndefined();
  });

  it("ends an older waiting poll when a newer one arrives, and gives jobs to the newer one", async () => {
    const link = new HostLink({ pollTimeoutMs: 1_000 });
    const older = link.poll(INFO);
    const newer = link.poll(INFO);
    expect(await older).toBeUndefined();
    const call = link.call("remount", {});
    const job = await newer;
    expect(job?.method).toBe("remount");
    link.reply({ id: job?.id ?? "", ok: true, result: { accepted: true } });
    await expect(call).resolves.toEqual({ accepted: true });
  });

  it("ends a poll whose request went away", async () => {
    const link = new HostLink({ pollTimeoutMs: 1_000 });
    const request = new AbortController();
    const poll = link.poll(INFO, request.signal);
    request.abort();
    expect(await poll).toBeUndefined();
  });

  it("counts as connected while a poll waits and for the window after it ends", async () => {
    let now = 1_000_000;
    const link = new HostLink({ pollTimeoutMs: 1_000, connectedWindowMs: 35_000, now: () => now });
    expect(link.status()).toEqual({ connected: false });

    const request = new AbortController();
    const poll = link.poll(INFO, request.signal);
    now += 60_000;
    expect(link.isConnected()).toBe(true);
    request.abort();
    await poll;

    now += 34_999;
    expect(link.status()).toEqual({
      connected: true,
      info: INFO,
      lastSeen: new Date(1_060_000).toISOString(),
    });
    now += 1;
    expect(link.isConnected()).toBe(false);
  });

  it("ends the waiting poll on close and answers later polls at once", async () => {
    const link = new HostLink({ pollTimeoutMs: 60_000 });
    const poll = link.poll(INFO);
    link.close();
    expect(await poll).toBeUndefined();
    expect(await link.poll(INFO)).toBeUndefined();
  });
});
