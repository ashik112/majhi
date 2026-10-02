import { TurnsSettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  afterLimit,
  firedLimit,
  limitPhrase,
  MAX_STRIKES,
  type TurnLimits,
  type TurnState,
  turnLimitsFor,
} from "./turn-limits.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const defaults = TurnsSettingsSchema.parse({});
const limits: TurnLimits = { maxMs: 2 * HOUR, idleMs: 25 * MIN, maxToolCalls: undefined };

function state(patch: Partial<TurnState>): TurnState {
  return { now: 0, startedAt: 0, activeAt: 0, toolCalls: 0, waiting: false, asking: false, ...patch };
}

describe("turnLimitsFor", () => {
  it("defaults to 2 hours, 25 minutes idle and no tool call cap", () => {
    expect(turnLimitsFor(defaults, undefined, undefined)).toEqual(limits);
  });

  it("takes each field from the agent, then the org, then majhi", () => {
    const org = { max_length: "1h", max_tool_calls: 300 } as const;
    const agent = { max_length: "30m" } as const;
    expect(turnLimitsFor(defaults, org, agent)).toEqual({
      maxMs: 30 * MIN,
      idleMs: 25 * MIN,
      maxToolCalls: 300,
    });
  });

  it("turns a limit off at any level", () => {
    const global = TurnsSettingsSchema.parse({ max_tool_calls: 100 });
    expect(turnLimitsFor(global, { idle: "off" }, { max_length: "off", max_tool_calls: 0 })).toEqual({
      maxMs: undefined,
      idleMs: undefined,
      maxToolCalls: undefined,
    });
  });

  it("lets an agent turn back on what its org turned off", () => {
    expect(turnLimitsFor(defaults, { idle: "off" }, { idle: "10m" }).idleMs).toBe(10 * MIN);
  });
});

describe("firedLimit", () => {
  it("fires nothing inside every limit", () => {
    expect(firedLimit(state({ now: HOUR, activeAt: HOUR - MIN }), limits)).toBeUndefined();
  });

  it("fires length once the turn has run its maximum, even while busy", () => {
    expect(firedLimit(state({ now: 2 * HOUR, activeAt: 2 * HOUR }), limits)).toBe("length");
  });

  it("fires idle after 25 minutes without activity", () => {
    expect(firedLimit(state({ now: HOUR, activeAt: HOUR - 25 * MIN }), limits)).toBe("idle");
    expect(firedLimit(state({ now: HOUR, activeAt: HOUR - 24 * MIN }), limits)).toBeUndefined();
  });

  it("does not fire idle while the agent waits on a wait process", () => {
    expect(firedLimit(state({ now: HOUR, activeAt: 0, waiting: true }), limits)).toBeUndefined();
  });

  it("still fires length while the agent waits on a wait process", () => {
    expect(firedLimit(state({ now: 2 * HOUR, waiting: true }), limits)).toBe("length");
  });

  it("fires nothing while a permission prompt waits for the owner", () => {
    expect(firedLimit(state({ now: 3 * HOUR, asking: true }), limits)).toBeUndefined();
  });

  it("fires tools at the cap, and only when a cap is set", () => {
    const capped = { ...limits, maxToolCalls: 200 };
    expect(firedLimit(state({ toolCalls: 199 }), capped)).toBeUndefined();
    expect(firedLimit(state({ toolCalls: 200 }), capped)).toBe("tools");
    expect(firedLimit(state({ toolCalls: 5000 }), limits)).toBeUndefined();
  });

  it("prefers length over tools over idle when several are over", () => {
    const capped = { ...limits, maxToolCalls: 10 };
    expect(firedLimit(state({ now: 3 * HOUR, toolCalls: 10 }), capped)).toBe("length");
    expect(firedLimit(state({ now: HOUR, toolCalls: 10 }), capped)).toBe("tools");
  });

  it("fires nothing with every limit off", () => {
    const off: TurnLimits = { maxMs: undefined, idleMs: undefined, maxToolCalls: undefined };
    expect(firedLimit(state({ now: 100 * HOUR, toolCalls: 1e6 }), off)).toBeUndefined();
  });
});

describe("afterLimit", () => {
  it("continues while hits without new commits stay under three", () => {
    expect(afterLimit(0, false)).toEqual({ action: "continue", strikes: 1 });
    expect(afterLimit(1, false)).toEqual({ action: "continue", strikes: 2 });
  });

  it("pauses on the third hit in a row without new commits, and starts over after", () => {
    expect(MAX_STRIKES).toBe(3);
    expect(afterLimit(2, false)).toEqual({ action: "pause", strikes: 0 });
  });

  it("a hit whose turn made a new commit continues and resets the count", () => {
    expect(afterLimit(2, true)).toEqual({ action: "continue", strikes: 0 });
  });
});

describe("limitPhrase", () => {
  it("names the limit that fired", () => {
    expect(limitPhrase("builder", "length", limits)).toBe("@builder reached the 2 hour turn limit");
    expect(limitPhrase("builder", "idle", limits)).toBe("@builder was idle for 25 minutes");
    expect(limitPhrase("builder", "tools", { ...limits, maxToolCalls: 300 })).toBe(
      "@builder reached the limit of 300 tool calls in one turn",
    );
  });
});
