import { type DeadlineUpsertInput, DeadlineUpsertInputSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { DeadlinesService } from "./deadlines.ts";
import type { BusinessActor } from "./scope.ts";
import { daysUntil, dueInstant, reminderInstants, stateOf, zonedToUtc } from "./time.ts";

/** Deadlines: time zones, daylight saving, reminders, states, and who sees which date. */

const OWNER: BusinessActor = { kind: "owner" };
const ACME: BusinessActor = { kind: "captain", org: "acme" };
const GLOBEX: BusinessActor = { kind: "agent", id: "scout", org: "globex" };

function setup(now = "2026-10-04T08:00:00.000Z") {
  const store = new Store(":memory:");
  const clock = { at: new Date(now) };
  const orgs = new Set(["acme", "globex", "private"]);
  const deadlines = new DeadlinesService({
    db: store.raw,
    now: () => clock.at,
    orgExists: async (o) => orgs.has(o),
    findingExists: (id) => id === 7,
  });
  const put = (over: Partial<DeadlineUpsertInput>, actor: BusinessActor = OWNER) =>
    deadlines.upsert(
      DeadlineUpsertInputSchema.parse({
        kind: "hackathon",
        title: "Spring hack",
        due: "2026-11-20",
        tz: "UTC",
        ...over,
      }),
      actor,
    );
  return { store, deadlines, put, clock };
}

describe("time zones", () => {
  it("puts the end of an all-day deadline at the end of that day in its own zone", () => {
    expect(dueInstant("2026-11-20", "UTC").toISOString()).toBe("2026-11-20T23:59:59.000Z");
    // Kiritimati is 14 hours ahead, Los Angeles 8 behind: the same date is 22 hours apart.
    expect(dueInstant("2026-11-20", "Pacific/Kiritimati").toISOString()).toBe("2026-11-20T09:59:59.000Z");
    expect(dueInstant("2026-11-20", "America/Los_Angeles").toISOString()).toBe("2026-11-21T07:59:59.000Z");
    expect(dueInstant("2026-11-20T17:00", "Asia/Kolkata").toISOString()).toBe("2026-11-20T11:30:00.000Z");
  });

  it("calls the same deadline overdue in one zone and today in another", () => {
    const now = new Date("2026-11-20T10:00:00.000Z");
    expect(stateOf("2026-11-20", "Pacific/Kiritimati", now, true)).toBe("overdue");
    expect(stateOf("2026-11-20", "America/Los_Angeles", now, true)).toBe("today");
    expect(daysUntil("2026-11-20", "Pacific/Kiritimati", now)).toBe(-1);
    expect(daysUntil("2026-11-20", "America/Los_Angeles", now)).toBe(0);
    expect(daysUntil("2026-11-27", "America/Los_Angeles", now)).toBe(7);
    expect(stateOf("2026-11-27", "America/Los_Angeles", now, true)).toBe("soon");
    expect(stateOf("2026-11-28", "America/Los_Angeles", now, true)).toBe("later");
    expect(stateOf("2026-11-20", "UTC", now, false)).toBe("closed");
  });

  it("turns a timed deadline overdue the minute it passes, not at midnight", () => {
    expect(stateOf("2026-11-20T09:00", "UTC", new Date("2026-11-20T08:59:00.000Z"), true)).toBe("today");
    expect(stateOf("2026-11-20T09:00", "UTC", new Date("2026-11-20T09:01:00.000Z"), true)).toBe("overdue");
  });

  it("follows daylight saving: the same wall time is an hour apart across the change", () => {
    // Berlin goes from +1 to +2 on 2026-03-29 at 02:00.
    expect(zonedToUtc({ y: 2026, m: 3, d: 28, h: 9, mi: 0, s: 0 }, "Europe/Berlin").toISOString()).toBe(
      "2026-03-28T08:00:00.000Z",
    );
    expect(zonedToUtc({ y: 2026, m: 3, d: 30, h: 9, mi: 0, s: 0 }, "Europe/Berlin").toISOString()).toBe(
      "2026-03-30T07:00:00.000Z",
    );
    // 02:30 on the day does not exist; it lands after the gap, never before it.
    const gap = zonedToUtc({ y: 2026, m: 3, d: 29, h: 2, mi: 30, s: 0 }, "Europe/Berlin");
    expect(gap.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-03-29T01:00:00.000Z"));
    expect(gap.getTime()).toBeLessThanOrEqual(Date.parse("2026-03-29T01:30:00.000Z"));
    // 02:30 on 2026-10-25 happens twice; one of the two real moments is chosen.
    const twice = zonedToUtc({ y: 2026, m: 10, d: 25, h: 2, mi: 30, s: 0 }, "Europe/Berlin").toISOString();
    expect(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]).toContain(twice);
  });

  it("sets reminders at 09:00 local on each lead day, across a daylight saving change", () => {
    const at = reminderInstants("2026-03-30", "Europe/Berlin", [1, 7, 0]).map((d) => d.toISOString());
    expect(at).toEqual(["2026-03-23T08:00:00.000Z", "2026-03-29T07:00:00.000Z", "2026-03-30T07:00:00.000Z"]);
  });

  it("never sets a reminder after the deadline itself", () => {
    const [only] = reminderInstants("2026-11-20T07:00", "UTC", [0]);
    expect(only?.toISOString()).toBe("2026-11-20T07:00:00.000Z");
  });

  it("refuses a date that is not on the calendar, a time out of range and an unknown zone", async () => {
    const t = setup();
    await expect(t.put({ due: "2026-02-30" })).rejects.toThrow(/not a real date/);
    await expect(t.put({ due: "2027-02-29" })).rejects.toThrow(/not a real date/);
    await expect(t.put({ due: "2026-11-20T25:00" })).rejects.toThrow(/not a real date/);
    expect(
      DeadlineUpsertInputSchema.safeParse({ kind: "grant", title: "x", due: "2026-11-20", tz: "Mars/Base" })
        .success,
    ).toBe(false);
    expect(
      DeadlineUpsertInputSchema.safeParse({ kind: "grant", title: "x", due: "next friday" }).success,
    ).toBe(false);
    await expect(t.put({ due: "2028-02-29" })).resolves.toMatchObject({ due: "2028-02-29" });
  });
});

describe("the list", () => {
  it("orders by the moment each falls due across zones, with days left and the next reminder", async () => {
    const t = setup();
    await t.put({ title: "LA grant", kind: "grant", due: "2026-10-20", tz: "America/Los_Angeles" });
    await t.put({ title: "Kiritimati hack", due: "2026-10-20", tz: "Pacific/Kiritimati" });
    await t.put({ title: "Renewal", kind: "renewal", due: "2026-10-05" });
    const list = t.deadlines.list({ limit: 10 }, OWNER).deadlines;
    expect(list.map((d) => d.title)).toEqual(["Renewal", "Kiritimati hack", "LA grant"]);
    expect(list[0]).toMatchObject({ daysLeft: 1, state: "soon", allDay: true });
    // Lead days 14, 7 and 1. For the renewal only the 09:00 UTC reminder of the 4th is still ahead (it is 08:00).
    expect(list[0]?.nextReminder).toBe("2026-10-04T09:00:00.000Z");
    // 14 days before the 20th is the 6th, 09:00 in Los Angeles (daylight time, UTC-7).
    expect(list[2]?.nextReminder).toBe("2026-10-06T16:00:00.000Z");
  });

  it("skips reminders that have passed, and shows none for a closed deadline", async () => {
    const t = setup("2026-11-19T10:00:00.000Z");
    // Lead days 14, 7 and 1 have all passed by 10:00 on the day before.
    const d = await t.put({ due: "2026-11-20" });
    expect(d.nextReminder).toBeUndefined();
    const withZero = await t.put({ id: d.id, due: "2026-11-20", leadDays: [1, 0] });
    expect(withZero.nextReminder).toBe("2026-11-20T09:00:00.000Z");
    const done = await t.put({ id: d.id, due: "2026-11-20", leadDays: [1, 0], status: "done" });
    expect(done).toMatchObject({ state: "closed" });
    expect(done.nextReminder).toBeUndefined();
    expect(t.deadlines.list({ limit: 5 }, OWNER).deadlines).toEqual([]);
    expect(t.deadlines.list({ status: "all", limit: 5 }, OWNER).deadlines).toHaveLength(1);
  });

  it("filters by days ahead, keeping overdue ones, and by kind", async () => {
    const t = setup();
    await t.put({ title: "Past", due: "2026-10-01", kind: "client" });
    await t.put({ title: "Soon", due: "2026-10-10" });
    await t.put({ title: "Far", due: "2027-01-10" });
    expect(t.deadlines.list({ withinDays: 14, limit: 10 }, OWNER).deadlines.map((d) => d.title)).toEqual([
      "Past",
      "Soon",
    ]);
    expect(t.deadlines.list({ kind: "client", limit: 10 }, OWNER).deadlines.map((d) => d.title)).toEqual([
      "Past",
    ]);
    expect(t.deadlines.list({ limit: 10 }, OWNER).deadlines[0]?.state).toBe("overdue");
  });

  it("keeps the zone when an edit does not name one", async () => {
    const t = setup();
    const made = await t.put({ tz: "Asia/Tokyo" });
    const edited = await t.deadlines.upsert(
      DeadlineUpsertInputSchema.parse({
        id: made.id,
        kind: "hackathon",
        title: "Renamed",
        due: "2026-11-21",
      }),
      OWNER,
    );
    expect(edited).toMatchObject({ tz: "Asia/Tokyo", title: "Renamed", dueAt: "2026-11-21T14:59:59.000Z" });
  });
});

describe("who sees which deadline", () => {
  it("shows a lane its workspace and the business, and writes only into its own", async () => {
    const t = setup();
    await t.put({ title: "Business launch", kind: "launch" });
    await t.put({ title: "Acme renewal", kind: "renewal", org: "acme" });
    await t.put({ title: "Globex grant", kind: "grant", org: "globex" });
    expect(
      t.deadlines
        .list({ limit: 10 }, ACME)
        .deadlines.map((d) => d.title)
        .sort(),
    ).toEqual(["Acme renewal", "Business launch"]);
    expect(() => t.deadlines.list({ org: "globex", limit: 10 }, ACME)).toThrow(/another workspace/);
    expect((await t.put({ title: "Mine" }, GLOBEX)).org).toBe("globex");
    await expect(t.put({ org: "acme" }, GLOBEX)).rejects.toThrow(/another workspace/);
    const theirs = t.deadlines.list({ limit: 10 }, OWNER).deadlines.find((d) => d.title === "Globex grant");
    await expect(t.put({ id: theirs?.id, title: "Hijack" }, ACME)).rejects.toThrow(/does not exist/);
    const biz = t.deadlines.list({ limit: 10 }, OWNER).deadlines.find((d) => d.title === "Business launch");
    await expect(t.put({ id: biz?.id, title: "Hijack" }, ACME)).rejects.toThrow(/another scope/);
    expect(() => t.deadlines.remove(biz?.id ?? 0, ACME)).toThrow(/Only the owner/);
  });

  it("links a finding only if it exists", async () => {
    const t = setup();
    await expect(t.put({ finding: 99 })).rejects.toThrow(/does not exist/);
    await expect(t.put({ finding: 7 })).resolves.toMatchObject({ finding: 7 });
  });
});
