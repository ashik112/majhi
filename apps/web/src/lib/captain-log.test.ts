import type { CaptainAction } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type CaptainLog, mergeLog, replaceAction } from "./captain-log";

const action = (id: number, extra: Partial<CaptainAction> = {}): CaptainAction => ({
  id,
  at: "2026-01-01T00:00:00.000Z",
  org: "acme",
  chore: "ship",
  text: `action ${id}`,
  reason: "r",
  outcome: "done",
  ...extra,
});

const held: CaptainLog = { actions: [action(5), action(4), action(3)], runs: [] };

describe("merging a catch-up read into the held captain log", () => {
  it("puts new lines first and keeps the held lines as they were", () => {
    const merged = mergeLog(held, { actions: [action(7), action(6)], runs: [] });
    expect(merged?.actions.map((a) => a.id)).toEqual([7, 6, 5, 4, 3]);
    expect(merged?.actions[2]).toBe(held.actions[0]);
  });

  it("changes nothing when nothing is new", () => {
    expect(mergeLog(held, { actions: [], runs: [] })).toBe(held);
  });

  it("keeps at most the limit", () => {
    const merged = mergeLog(held, { actions: [action(7), action(6)], runs: [] }, 4);
    expect(merged?.actions.map((a) => a.id)).toEqual([7, 6, 5, 4]);
  });

  it("asks for a full read when the catch-up filled its page", () => {
    expect(mergeLog(held, { actions: [action(8), action(7)], runs: [] }, 2)).toBeNull();
  });

  it("replaces an undone line", () => {
    const next = replaceAction(held, action(4, { undo: "done" }));
    expect(next.actions.map((a) => a.undo)).toEqual([undefined, "done", undefined]);
  });
});
