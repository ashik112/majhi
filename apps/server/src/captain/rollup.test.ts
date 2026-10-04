import { describe, expect, it } from "vitest";
import {
  type Clock,
  type Facts,
  NOTABLE_MS,
  PERIODIC_MS,
  type RollupState,
  rollupOf,
  step,
} from "./rollup.ts";

const H = 60 * 60_000;
const EMPTY: Facts = { orgs: [], incidents: [], capsHit: [], spend: "Spend today: $1.00." };
const acme = (over: Partial<Facts["orgs"][number]> = {}): Facts => ({
  ...EMPTY,
  orgs: [{ org: "acme", name: "Acme", moved: [], stuck: [], waiting: [], ...over }],
});
const clock = (now: number, over: Partial<Clock> = {}): Clock => ({
  now,
  day: "2026-10-04",
  clock: "10:00",
  morningAt: "08:00",
  autopilot: true,
  ...over,
});
const fresh: RollupState = { seen: [] };
const T0 = Date.parse("2026-10-04T10:00:00Z");
const quiet = rollupOf(acme(), T0);
const settled: RollupState = {
  seen: [],
  morningDay: "2026-10-04",
  checkedAt: T0,
  postedAt: T0,
  hash: quiet.hash,
};

describe("rollup text", () => {
  it("writes one line per workspace with ages and task ids", () => {
    const r = rollupOf(
      acme({
        moved: [{ id: "ACM-1", title: "Fix login", what: "shipped" }],
        stuck: [{ id: "ACM-2", why: "paused, account at its limit" }],
        waiting: [{ id: "ACM-3", kind: "secret", since: T0 - 5 * H, lane: false }],
      }),
      T0,
    );
    expect(r.text).toBe(
      "Captain update.\nAcme: shipped ACM-1 Fix login. Stuck: ACM-2 paused, account at its limit. Needs you: 1, oldest 5h (ACM-3).\nSpend today: $1.00.",
    );
  });

  it("the hash ignores the spend line and the age", () => {
    const w = acme({ waiting: [{ id: "ACM-3", kind: "secret", since: T0 - 3 * H, lane: false }] });
    const later = acme({ waiting: [{ id: "ACM-3", kind: "secret", since: T0 - 3 * H, lane: false }] });
    const a = rollupOf({ ...w, spend: "Spend today: $1." }, T0);
    const b = rollupOf({ ...later, spend: "Spend today: $9." }, T0 + H);
    expect(a.hash).toBe(b.hash);
  });
});

describe("rollup schedule", () => {
  it("posts the morning once a day, after the hour", () => {
    expect(step(fresh, clock(T0, { clock: "07:59", autopilot: false }), quiet).post).toBeUndefined();
    const first = step(fresh, clock(T0, { autopilot: false }), quiet);
    expect(first.post).toBe("morning");
    const changed = rollupOf(acme({ stuck: [{ id: "A-1", why: "x" }] }), T0);
    expect(step(first.state, clock(T0 + 60_000, { autopilot: false }), changed).post).toBeUndefined();
  });

  it("posts every 3 hours only while Auto-pilot is on", () => {
    const s: RollupState = { ...settled, hash: "old" };
    expect(step(s, clock(T0 + PERIODIC_MS - 1), quiet).post).toBeUndefined();
    expect(step(s, clock(T0 + PERIODIC_MS, { autopilot: false }), quiet).post).toBeUndefined();
    expect(step(s, clock(T0 + PERIODIC_MS), quiet).post).toBe("periodic");
  });

  it("posts nothing when the content is unchanged, and does not retry next minute", () => {
    const out = step(settled, clock(T0 + PERIODIC_MS), quiet);
    expect(out.post).toBeUndefined();
    expect(out.state.checkedAt).toBe(T0 + PERIODIC_MS);
    expect(step(out.state, clock(T0 + PERIODIC_MS + 60_000), quiet).post).toBeUndefined();
  });

  it("batches events: one notable post per 15 minutes, the rest wait", () => {
    const one = rollupOf(acme({ moved: [{ id: "A-1", title: "One", what: "shipped" }] }), T0);
    const two = rollupOf(
      acme({
        moved: [
          { id: "A-1", title: "One", what: "shipped" },
          { id: "A-2", title: "Two", what: "MR opened" },
        ],
      }),
      T0,
    );
    const a = step(settled, clock(T0 + 60_000), one);
    expect(a.post).toBe("notable");
    const b = step(a.state, clock(T0 + 5 * 60_000), two);
    expect(b.post).toBeUndefined();
    expect(b.state.seen).toEqual(a.state.seen);
    expect(step(b.state, clock(T0 + 60_000 + NOTABLE_MS), two).post).toBe("notable");
  });

  it("an item waiting over 2 hours and a lane card are events", () => {
    const w = (since: number, lane = false) =>
      rollupOf(acme({ waiting: [{ id: "A-9", kind: "permission", since, lane }] }), T0);
    expect(step(settled, clock(T0 + 60_000), w(T0 - H)).post).toBeUndefined();
    expect(step(settled, clock(T0 + 60_000), w(T0 - 3 * H)).post).toBe("notable");
    expect(step(settled, clock(T0 + 60_000), w(T0 - 60_000, true)).post).toBe("notable");
  });
});
