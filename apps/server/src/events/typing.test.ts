import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerTyping, TYPING_FRESH_MS } from "./typing.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function tracker() {
  const typing = new OwnerTyping(() => Date.now());
  const idle: string[] = [];
  typing.onIdle((task) => idle.push(task));
  return { typing, idle };
}

describe("the owner typing in a task", () => {
  it("holds only the task they type in", () => {
    const { typing } = tracker();
    const tab = {};
    typing.report(tab, "ACM-1");
    expect(typing.holds("ACM-1")).toBe(true);
    expect(typing.holds("ACM-2")).toBe(false);
    typing.report(tab, "ACM-2");
    expect(typing.holds("ACM-1")).toBe(false);
    expect(typing.holds("ACM-2")).toBe(true);
  });

  it("expires 15 seconds after the last report, and a repeated report keeps it", () => {
    const { typing, idle } = tracker();
    const tab = {};
    typing.report(tab, "ACM-1");
    expect(typing.holds("ACM-1")).toBe(true);
    vi.advanceTimersByTime(TYPING_FRESH_MS - 1_000);
    typing.report(tab, "ACM-1");
    vi.advanceTimersByTime(TYPING_FRESH_MS - 1_000);
    expect(typing.holds("ACM-1")).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(typing.holds("ACM-1")).toBe(false);
    // The wait ended on its own: the captain is told.
    vi.advanceTimersByTime(1_000);
    expect(idle).toEqual(["ACM-1"]);
  });

  it("is cleared when the socket closes, and tells the captain it waited on", () => {
    const { typing, idle } = tracker();
    const tab = {};
    typing.report(tab, "ACM-1");
    expect(typing.holds("ACM-1")).toBe(true);
    typing.drop(tab);
    expect(typing.holds("ACM-1")).toBe(false);
    expect(idle).toEqual(["ACM-1"]);
  });

  it("tells the captain once the last tab stops, and not about tasks it never waited on", () => {
    const { typing, idle } = tracker();
    const [a, b] = [{}, {}];
    typing.report(a, "ACM-1");
    typing.report(b, "ACM-1");
    typing.report(a, "ACM-2");
    expect(typing.holds("ACM-1")).toBe(true);
    typing.report(b, undefined);
    expect(idle).toEqual(["ACM-1"]);
    typing.report(a, undefined);
    expect(idle).toEqual(["ACM-1"]);
  });
});
