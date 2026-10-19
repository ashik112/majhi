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
});
