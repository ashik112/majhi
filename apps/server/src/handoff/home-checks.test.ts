import type { HandoffState } from "@majhi/shared";
import { describe, expect, it, vi } from "vitest";
import { HomeChecks } from "./home-checks.ts";

const idle = (task: string): HandoffState => ({
  task,
  stale: false,
  history: [],
  strikes: 0,
  escalated: false,
  running: false,
  queued: false,
});
function fixture() {
  let now = 0;
  let ids = ["ACM-1", "ACM-2"];
  const state = vi.fn(async (id: string) => idle(id));
  const mergeChecks = vi.fn(async () => ({ verdict: { kind: "ok" as const }, head: "api@a1" }));
  const empty = vi.fn(async () => false);
  const home = new HomeChecks({
    ids: () => ids,
    state,
    mergeChecks,
    empty,
    lastMessage: () => "Finished the change. More detail.",
    now: () => now,
  });
  return {
    home,
    state,
    mergeChecks,
    empty,
    advance: (ms: number) => {
      now += ms;
    },
    ids: (next: string[]) => {
      ids = next;
    },
  };
}

describe("Home review facts", () => {
  it("reuses the complete row before any Git reads and expires after twenty seconds", async () => {
    const f = fixture();
    const first = await f.home.facts();
    f.advance(19_999);
    expect(await f.home.facts()).toEqual(first);
    expect(f.state).toHaveBeenCalledTimes(2);
    expect(f.mergeChecks).toHaveBeenCalledTimes(2);
    expect(f.empty).toHaveBeenCalledTimes(2);
    f.advance(1);
    await f.home.facts();
    expect(f.state).toHaveBeenCalledTimes(4);
  });

  it("a change refreshes only the named task, including its handoff activity", async () => {
    const f = fixture();
    await f.home.facts();
    f.state.mockImplementation(async (id) => ({
      ...idle(id),
      running: true,
      activity: { phase: "running", since: "2026-01-01T00:00:00.000Z", step: "tests" },
    }));
    f.home.invalidate(["ACM-1"]);
    const fresh = await f.home.facts();
    expect(f.state).toHaveBeenCalledTimes(3);
    expect(fresh.background).toEqual([
      { task: "ACM-1", kind: "check", label: "tests", since: "2026-01-01T00:00:00.000Z" },
    ]);
    f.home.invalidate();
    await f.home.facts();
    expect(f.state).toHaveBeenCalledTimes(5);
  });

  it("coalesces simultaneous polls and limits outstanding task reads", async () => {
    const f = fixture();
    f.ids(Array.from({ length: 25 }, (_, i) => `ACM-${i}`));
    let active = 0;
    let peak = 0;
    f.state.mockImplementation(async (id) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return idle(id);
    });
    const results = await Promise.all([f.home.facts(), f.home.facts(), f.home.facts()]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.checks.map((row) => row.task)).toEqual(
      Array.from({ length: 25 }, (_, i) => `ACM-${i}`),
    );
    expect(f.state).toHaveBeenCalledTimes(25);
    expect(peak).toBe(4);
  });

  it("does not cache a verdict read across an invalidation", async () => {
    const f = fixture();
    f.ids(["ACM-1"]);
    let release!: (value: HandoffState) => void;
    f.state.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.home.facts();
    f.home.invalidate(["ACM-1"]);
    release(idle("ACM-1"));
    await pending;
    await f.home.facts();
    expect(f.state).toHaveBeenCalledTimes(2);
  });

  it("removes departed tasks and reads a fresh verdict if they return to review", async () => {
    const f = fixture();
    await f.home.facts();
    f.ids([]);
    expect(await f.home.facts()).toEqual({ checks: [], background: [] });
    f.ids(["ACM-1"]);
    await f.home.facts();
    expect(f.state).toHaveBeenCalledTimes(3);
  });

  it("retries failed reads instead of caching a missing verdict", async () => {
    const f = fixture();
    f.ids(["ACM-1"]);
    f.mergeChecks.mockRejectedValueOnce(new Error("Git unavailable"));
    expect((await f.home.facts()).checks).toEqual([]);
    expect((await f.home.facts()).checks).toHaveLength(1);
    expect(f.state).toHaveBeenCalledTimes(2);
  });
});
