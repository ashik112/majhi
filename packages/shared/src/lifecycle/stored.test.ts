import { describe, expect, it } from "vitest";
import type { HoldCause } from "./hold.ts";
import { HoldSchema } from "./hold.ts";
import {
  fromStored,
  LEGACY_ALERT,
  STOPPED_NOW,
  type StoredContext,
  type StoredFields,
  toStored,
} from "./stored.ts";

const AT = "2026-10-05T10:00:00.000Z";
const RESUMED = "2026-10-05T09:00:00.000Z";
const ctx = (o: Partial<StoredContext> = {}): StoredContext => ({ at: AT, ...o });

interface Combo {
  name: string;
  fields: StoredFields;
  ctx?: Partial<StoredContext>;
  /** What the migration reads it as. */
  status: string;
  hold: HoldCause | undefined;
}

/** The combinations of stored fields that exist today (design 4.1, 4.3, E1 and the code that writes them). */
const EXISTING: Combo[] = [
  ...(["inbox", "ready", "running", "review", "mr", "done"] as const).map(
    (status): Combo => ({ name: `${status}, no pause`, fields: { status }, status, hold: undefined }),
  ),
  {
    name: "paused by the owner",
    fields: { status: "paused", pausedReason: "owner" },
    ctx: { lane: "running" },
    status: "running",
    hold: "owner-stop",
  },
  {
    name: "owner pause in review",
    fields: { status: "paused", pausedReason: "owner" },
    ctx: { lane: "review" },
    status: "review",
    hold: "owner-stop",
  },
  {
    name: "paused by the captain",
    fields: { status: "paused", pausedReason: "owner", pausedBy: "captain" },
    ctx: { lane: "running" },
    status: "running",
    hold: "captain-stop",
  },
  {
    name: "paused when Auto-pilot was turned off (stop now)",
    fields: {
      status: "paused",
      pausedReason: "owner",
      pausedBy: "autonomy-off",
      held: "owner",
      heldScope: STOPPED_NOW,
    },
    ctx: { lane: "running" },
    status: "running",
    hold: "autopilot-off",
  },
  {
    name: "Auto-pilot is stopping (step): run held, task still running",
    fields: { status: "running", held: "owner" },
    status: "running",
    hold: "autopilot-off",
  },
  {
    name: "Auto-pilot step on a task in review",
    fields: { status: "review", held: "owner" },
    status: "review",
    hold: "autopilot-off",
  },
  {
    name: "limit from the run gate, day cap",
    fields: { status: "paused", pausedReason: "limit", held: "limit", heldScope: "day" },
    ctx: { lane: "running" },
    status: "running",
    hold: "budget-limit",
  },
  {
    name: "limit from the run gate, org cap",
    fields: { status: "paused", pausedReason: "limit", held: "limit", heldScope: "acme" },
    ctx: { lane: "running" },
    status: "running",
    hold: "budget-limit",
  },
  {
    name: "limit from a budget alert",
    fields: { status: "paused", pausedReason: "limit" },
    ctx: { lane: "running", alertId: "alert-7" },
    status: "running",
    hold: "budget-limit",
  },
  {
    name: "limit with nothing known (restart)",
    fields: { status: "paused", pausedReason: "limit" },
    ctx: { lane: "running" },
    status: "running",
    hold: "budget-limit",
  },
  {
    name: "limit on an account",
    fields: { status: "paused", pausedReason: "limit" },
    ctx: { lane: "running", accountLimit: { account: "claude-acme" } },
    status: "running",
    hold: "account-limit",
  },
  {
    name: "offline",
    fields: { status: "paused", pausedReason: "offline" },
    ctx: { lane: "running" },
    status: "running",
    hold: "offline",
  },
  {
    name: "signed out",
    fields: { status: "paused", pausedReason: "signed-out" },
    ctx: { lane: "running", account: "claude-acme" },
    status: "running",
    hold: "signed-out",
  },
  {
    name: "error",
    fields: { status: "paused", pausedReason: "error" },
    ctx: { lane: "running", error: "boom", phase: "start" },
    status: "running",
    hold: "error",
  },
  {
    name: "loop guard",
    fields: { status: "paused", pausedReason: "loop" },
    ctx: { lane: "running" },
    status: "running",
    hold: "loop-guard",
  },
  {
    name: "blocked by the idle watch",
    fields: { status: "paused", pausedReason: "blocked" },
    ctx: { lane: "running", blocked: "idle" },
    status: "running",
    hold: "idle",
  },
  {
    name: "blocked, never run, default reading",
    fields: { status: "paused", pausedReason: "blocked" },
    ctx: { lane: "ready", on: ["ACME-2"] },
    status: "ready",
    hold: "dependency-closed",
  },
  {
    name: "blocked on a closed dependency in inbox",
    fields: { status: "paused", pausedReason: "blocked" },
    ctx: { lane: "inbox", blocked: "dependency-closed", on: ["ACME-2"] },
    status: "inbox",
    hold: "dependency-closed",
  },
  {
    name: "blocked on a removed dependency",
    fields: { status: "paused", pausedReason: "blocked" },
    ctx: { lane: "ready", blocked: "dependency-removed", on: ["ACME-2", "ACME-3"] },
    status: "ready",
    hold: "dependency-removed",
  },
  {
    name: "running, the owner resumed a limit by hand",
    fields: { status: "running", resumedAt: RESUMED },
    ctx: { resumedAt: RESUMED },
    status: "running",
    hold: undefined,
  },
  {
    name: "paused at a limit after a hand resume",
    fields: { status: "paused", pausedReason: "limit", held: "limit", heldScope: "day", resumedAt: RESUMED },
    ctx: { lane: "running", resumedAt: RESUMED },
    status: "running",
    hold: "budget-limit",
  },
];

describe("stored fields to the new model", () => {
  it.each(EXISTING)("$name reads as $status with hold $hold", (c) => {
    const out = fromStored(c.fields, ctx(c.ctx));
    expect(out.status).toBe(c.status);
    expect(out.hold?.cause).toBe(c.hold);
    if (out.hold !== undefined) expect(HoldSchema.safeParse(out.hold).success).toBe(true);
    expect(out.exemptUntilRunEnds).toBe(c.fields.resumedAt !== undefined);
  });

  it("an org cap keeps the org and a day cap is the all-workspaces day", () => {
    const org = fromStored(
      { status: "paused", pausedReason: "limit", held: "limit", heldScope: "acme" },
      ctx({ lane: "running" }),
    );
    expect(org.hold).toMatchObject({ cause: "budget-limit", scope: "org", scopeId: "acme", period: "day" });
    const day = fromStored(
      { status: "paused", pausedReason: "limit", held: "limit", heldScope: "day" },
      ctx({ lane: "running" }),
    );
    expect(day.hold).toMatchObject({ cause: "budget-limit", scope: "all", period: "day" });
    expect(day.hold).not.toHaveProperty("alertId");
  });

  it("a plain limit with no held row is marked legacy, so it is not taken for a run-gate cap", () => {
    const out = fromStored({ status: "paused", pausedReason: "limit" }, ctx({ lane: "running" }));
    expect(out.hold).toMatchObject({ cause: "budget-limit", alertId: LEGACY_ALERT });
  });

  it("Auto-pilot off with no pausedBy but held = owner at stop-now still reads as autopilot-off", () => {
    const out = fromStored(
      { status: "paused", pausedReason: "owner", held: "owner", heldScope: STOPPED_NOW },
      ctx({ lane: "running" }),
    );
    expect(out.hold).toMatchObject({ cause: "autopilot-off", mode: "now" });
  });

  it("a paused row with no reason is an owner pause (older rows)", () => {
    expect(fromStored({ status: "paused" }, ctx({ lane: "running" })).hold?.cause).toBe("owner-stop");
  });

  it("blocked reads by its lane when nothing else says what it was", () => {
    expect(fromStored({ status: "paused", pausedReason: "blocked" }, ctx({ on: ["ACME-2"] }))).toMatchObject({
      status: "ready",
      hold: { cause: "dependency-closed" },
    });
    expect(
      fromStored({ status: "paused", pausedReason: "blocked" }, ctx({ lane: "review" })).hold?.cause,
    ).toBe("idle");
    expect(
      fromStored({ status: "paused", pausedReason: "blocked" }, ctx({ lane: "running" })).hold?.cause,
    ).toBe("idle");
  });

  it("a dependency pause with no known tasks still gets a valid hold, with a placeholder to replace", () => {
    const out = fromStored({ status: "paused", pausedReason: "blocked" }, ctx({ lane: "ready" }));
    expect(HoldSchema.safeParse(out.hold).success).toBe(true);
    expect(out.hold).toMatchObject({ on: ["UNKNOWN-1"] });
  });

  it("a paused task with no lane given returns to running, except a dependency pause, which returns to ready", () => {
    expect(fromStored({ status: "paused", pausedReason: "offline" }, ctx()).status).toBe("running");
    expect(fromStored({ status: "paused", pausedReason: "blocked" }, ctx({ on: ["ACME-2"] })).status).toBe(
      "ready",
    );
  });

  it("stale held rows on inbox, ready, mr and done are ignored", () => {
    for (const status of ["inbox", "ready", "mr", "done"] as const)
      expect(fromStored({ status, held: "limit", heldScope: "day" }, ctx()).hold).toBeUndefined();
  });

  it("a run held at a limit while the task still says running reads as a budget hold on running", () => {
    const out = fromStored({ status: "running", held: "limit", heldScope: "acme" }, ctx());
    expect(out.status).toBe("running");
    expect(out.hold).toMatchObject({ cause: "budget-limit", scope: "org", scopeId: "acme" });
  });
});

describe("the new model back to stored fields", () => {
  const roundTrips = EXISTING.filter(
    (c) => c.fields.pausedReason !== undefined || c.fields.status !== "paused",
  );

  it.each(roundTrips)("round trips: $name", (c) => {
    const x = ctx(c.ctx);
    const lifecycle = fromStored(c.fields, x);
    const back = toStored(lifecycle, x);
    expect(back.fields).toEqual(c.fields);
    if (c.fields.status === "paused") expect(back.lane).toBe(c.ctx?.lane);
    else expect(back.lane).toBeUndefined();
  });

  it("the old pause fields are written together with the held row for Auto-pilot", () => {
    const out = toStored(
      { status: "running", hold: { cause: "autopilot-off", at: AT, mode: "now" }, exemptUntilRunEnds: false },
      ctx(),
    );
    expect(out.fields).toEqual({
      status: "paused",
      pausedReason: "owner",
      pausedBy: "autonomy-off",
      held: "owner",
      heldScope: STOPPED_NOW,
    });
  });

  it("an exemption is written back with its time, or the update time when none was kept", () => {
    const state = { status: "running", hold: undefined, exemptUntilRunEnds: true } as const;
    expect(toStored(state, ctx({ resumedAt: RESUMED })).fields.resumedAt).toBe(RESUMED);
    expect(toStored(state, ctx()).fields.resumedAt).toBe(AT);
  });
});

/**
 * Stored combinations that cannot round-trip, each with the reason. The design lists the first
 * four as ambiguous (4.7 contradiction 4, E1); the rest are written by nothing today or are
 * collapsed on purpose.
 */
const LOSSY: {
  name: string;
  fields: StoredFields;
  ctx?: Partial<StoredContext>;
  becomes: StoredFields;
  why: string;
}[] = [
  {
    name: "paused with no reason",
    fields: { status: "paused" },
    ctx: { lane: "running" },
    becomes: { status: "paused", pausedReason: "owner" },
    why: "older rows have no reason; the new model writes the owner reason explicitly",
  },
  {
    name: "autonomy-off pause with no held row",
    fields: { status: "paused", pausedReason: "owner", pausedBy: "autonomy-off" },
    ctx: { lane: "running" },
    becomes: {
      status: "paused",
      pausedReason: "owner",
      pausedBy: "autonomy-off",
      held: "owner",
      heldScope: STOPPED_NOW,
    },
    why: "one hold, so the stop-now row is always written with it",
  },
  {
    name: "stop-now held row with no pausedBy",
    fields: { status: "paused", pausedReason: "owner", held: "owner", heldScope: STOPPED_NOW },
    ctx: { lane: "running" },
    becomes: {
      status: "paused",
      pausedReason: "owner",
      pausedBy: "autonomy-off",
      held: "owner",
      heldScope: STOPPED_NOW,
    },
    why: "design E1: held = owner at stop-now is autopilot-off(now), so pausedBy is filled in",
  },
  {
    name: "running task with a limit held row (the async window)",
    fields: { status: "running", held: "limit", heldScope: "day" },
    becomes: { status: "paused", pausedReason: "limit", held: "limit", heldScope: "day" },
    why: "the task and its run no longer disagree: the hold makes the task paused in the old fields (design 4.5 table, last row)",
  },
  {
    name: "paused limit hold on an org with no scope name",
    fields: { status: "paused", pausedReason: "limit", held: "limit" },
    ctx: { lane: "running" },
    becomes: { status: "paused", pausedReason: "limit", held: "limit", heldScope: "day" },
    why: "a missing scope is the day cap",
  },
  {
    name: "stale held row on a done task",
    fields: { status: "done", held: "limit", heldScope: "day" },
    becomes: { status: "done" },
    why: "a done task has no hold",
  },
  {
    name: "stale held row on an mr task",
    fields: { status: "mr", held: "owner" },
    becomes: { status: "mr" },
    why: "mr carries no hold in the old fields",
  },
];

describe("stored combinations that do not round-trip", () => {
  it.each(LOSSY)("$name: $why", (c) => {
    const x = ctx(c.ctx);
    expect(toStored(fromStored(c.fields, x), x).fields).toEqual(c.becomes);
  });

  it("a normalised combination is stable: reading it again changes nothing", () => {
    for (const c of LOSSY) {
      const x = ctx(c.ctx);
      const once = toStored(fromStored(c.fields, x), x);
      const twice = toStored(fromStored(once.fields, { ...x, lane: once.lane ?? x.lane }), x);
      expect(twice.fields).toEqual(once.fields);
    }
  });

  it("a hold in mr or done has no stored form and is dropped", () => {
    const hold = { cause: "offline", at: AT } as const;
    expect(toStored({ status: "mr", hold, exemptUntilRunEnds: false }, ctx()).fields).toEqual({
      status: "mr",
    });
    expect(toStored({ status: "done", hold, exemptUntilRunEnds: false }, ctx()).fields).toEqual({
      status: "done",
    });
  });

  it("budget limits other than the day and org caps are written as the day cap (no run-gate form)", () => {
    for (const scope of ["task", "account", "reserve"] as const) {
      const out = toStored(
        {
          status: "running",
          hold: { cause: "budget-limit", at: AT, scope, period: "week" },
          exemptUntilRunEnds: false,
        },
        ctx(),
      );
      expect(out.fields).toMatchObject({
        status: "paused",
        pausedReason: "limit",
        held: "limit",
        heldScope: "day",
      });
    }
  });
});
