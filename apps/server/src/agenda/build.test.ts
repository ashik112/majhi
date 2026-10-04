import type { AgendaItem } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type AgendaInput, buildItems, compareItems, plan } from "./build.ts";
import { deadline, decision, finding } from "./fixtures.ts";
import { briefDue } from "./time.ts";

/** The agenda's order, its ties, the review budget and deadlines across time zones. */

const NOW = new Date("2026-10-04T08:00:00.000Z");

function input(over: Partial<AgendaInput> = {}): AgendaInput {
  return {
    now: NOW,
    tz: "UTC",
    decisions: [],
    deadlines: [],
    findings: [],
    orgName: (o) => (o === "acme" ? "Acme" : undefined),
    ...over,
  };
}

const ids = (items: readonly AgendaItem[]) => items.map((i) => i.id);

describe("order", () => {
  it("puts incidents, overdue and due-today dates, then holds, then what waits, by urgency", () => {
    const items = buildItems(
      input({
        decisions: [
          decision({ id: "room:ACM-1:a", kind: "ship" }),
          decision({ id: "budget:day:2026-10-04", kind: "budget", title: "Raise the day budget?" }),
          decision({ id: "room:ACM-2:q", kind: "question", title: "Which currency?" }),
          decision({ id: "draft:3", kind: "draft", title: "Reply to Globex" }),
        ],
        deadlines: [
          deadline({ id: 1, due: "2026-10-04T17:00" }),
          deadline({ id: 2, due: "2026-10-02" }),
          deadline({ id: 3, due: "2026-10-12" }),
        ],
        findings: [
          finding({ id: 9, source: "incident", severity: "medium", title: "Checkout is down" }),
          finding({ id: 10, severity: "high" }),
        ],
      }),
    );
    expect(ids(items)).toEqual([
      "finding:9", // incident
      "deadline:2", // overdue
      "deadline:1", // due today
      "decision:budget:day:2026-10-04", // new work is on hold
      "finding:10", // high severity, nobody has taken it
      "decision:room:ACM-2:q", // an agent waits for an answer
      "decision:room:ACM-1:a", // ready to ship
      "decision:draft:3", // a draft
      "deadline:3", // eight days away
    ]);
  });

  it("puts the older decision first within a kind and breaks a full tie by id, in any input order", () => {
    const rows = [
      decision({ id: "room:ACM-3:c", at: "2026-10-04T07:00:00.000Z" }),
      decision({ id: "room:ACM-1:a", at: "2026-10-04T07:00:00.000Z" }),
      decision({ id: "room:ACM-2:b", at: "2026-10-01T07:00:00.000Z" }),
    ];
    const want = ["decision:room:ACM-2:b", "decision:room:ACM-1:a", "decision:room:ACM-3:c"];
    expect(ids(buildItems(input({ decisions: rows })))).toEqual(want);
    expect(ids(buildItems(input({ decisions: [...rows].reverse() })))).toEqual(want);
    expect(
      ids(buildItems(input({ decisions: [rows[1] as never, rows[2] as never, rows[0] as never] }))),
    ).toEqual(want);
  });

  it("is a total order: sorting any permutation gives the same list", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      decision({
        id: `room:ACM-${i}:x`,
        kind: i % 3 === 0 ? "question" : "ship",
        at: `2026-10-0${1 + (i % 3)}T07:00:00.000Z`,
      }),
    );
    const base = ids(buildItems(input({ decisions: rows })));
    for (let r = 0; r < 5; r++) {
      const shuffled = [...rows].sort(() => Math.random() - 0.5);
      expect(ids(buildItems(input({ decisions: shuffled })))).toEqual(base);
    }
  });

  it("compares items with no moment after items with one", () => {
    const a = { id: "a", weight: 1, at: "2026-10-01T00:00:00.000Z" } as AgendaItem;
    const b = { id: "b", weight: 1 } as AgendaItem;
    expect(compareItems(a, b)).toBeLessThan(0);
  });
});

describe("findings and incidents", () => {
  it("takes high findings and incidents above info, and nothing that someone already took", () => {
    const items = buildItems(
      input({
        findings: [
          finding({ id: 1, severity: "medium" }),
          finding({ id: 2, severity: "high", status: "task" }),
          finding({ id: 3, severity: "high", status: "dismissed" }),
          finding({ id: 4, source: "incident", severity: "info" }),
          finding({ id: 5, source: "incident", severity: "low", title: "Slow queue" }),
          finding({ id: 6, severity: "high" }),
        ],
      }),
    );
    expect(ids(items)).toEqual(["finding:5", "finding:6"]);
    expect(items[0]).toMatchObject({ kind: "incident", must: true, minutes: 10 });
    expect(items[1]).toMatchObject({
      kind: "finding",
      must: false,
      orgName: "Acme",
      done: { kind: "dismiss-finding", id: 6 },
    });
  });
});

describe("deadlines in the owner's calendar", () => {
  it("leaves out closed ones and ones past 14 days, and keeps overdue ones", () => {
    const items = buildItems(
      input({
        deadlines: [
          deadline({ id: 1, due: "2026-10-18" }),
          deadline({ id: 2, due: "2026-10-19" }),
          deadline({ id: 3, due: "2026-10-05", status: "done" }),
          deadline({ id: 4, due: "2026-09-20" }),
        ],
      }),
    );
    expect(ids(items)).toEqual(["deadline:4", "deadline:1"]);
    expect(items[0]?.must).toBe(true);
    expect(items[1]?.must).toBe(false);
  });

  it("reads a date by the moment it falls due in the owner's zone, not by its own zone's date", () => {
    // Berlin, the night before the clocks go forward: 2026-03-28 23:30.
    const now = new Date("2026-03-28T22:30:00.000Z");
    const berlin = (over: Parameters<typeof deadline>[0]) => deadline({ ...over, now });
    const items = buildItems(
      input({
        now,
        tz: "Europe/Berlin",
        deadlines: [
          // Ends 2026-03-29 23:59:59 in Los Angeles: 2026-03-30 07:59 in Berlin, two days out.
          berlin({ id: 1, due: "2026-03-29", tz: "America/Los_Angeles" }),
          // 09:00 on 2026-03-29 in Tokyo is 02:00 UTC... midnight UTC: tomorrow 01:00 in Berlin.
          berlin({ id: 2, due: "2026-03-29T09:00", tz: "Asia/Tokyo" }),
          // Ends the Honolulu day 2026-03-28: already past 10:00 in Berlin on the 29th? No: 09:59 UTC on the 29th.
          berlin({ id: 3, due: "2026-03-28", tz: "Pacific/Honolulu" }),
        ],
      }),
    );
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by["deadline:2"]?.why).toBe("Due tomorrow 01:00");
    expect(by["deadline:2"]?.must).toBe(false);
    expect(by["deadline:1"]?.why).toBe("Due Mon 30 Mar 08:59");
    // Honolulu's 28th ends at 2026-03-29 09:59:59 UTC, which is 11:59 in Berlin after the change.
    expect(by["deadline:3"]?.why).toBe("Due tomorrow 11:59");
    expect(ids(items)).toHaveLength(3);
  });

  it("calls a date due today only until the moment passes, then overdue", () => {
    const early = buildItems(
      input({
        now: new Date("2026-10-04T08:00:00.000Z"),
        deadlines: [deadline({ id: 1, due: "2026-10-04T17:00" })],
      }),
    );
    expect(early[0]).toMatchObject({ must: true, why: "Due today 17:00" });
    const late = buildItems(
      input({
        now: new Date("2026-10-04T18:00:00.000Z"),
        deadlines: [deadline({ id: 1, due: "2026-10-04T17:00" })],
      }),
    );
    expect(late[0]).toMatchObject({ must: true, why: "Overdue, it was due today 17:00" });
  });
});

describe("the brief hour", () => {
  it("is the wall-clock hour on the day the clocks go forward and back", () => {
    // New York: EDT starts 2026-03-08 at 02:00; EST returns 2026-11-01.
    expect(briefDue("2026-03-07", "08:00", "America/New_York").toISOString()).toBe(
      "2026-03-07T13:00:00.000Z",
    );
    expect(briefDue("2026-03-08", "08:00", "America/New_York").toISOString()).toBe(
      "2026-03-08T12:00:00.000Z",
    );
    expect(briefDue("2026-11-01", "08:00", "America/New_York").toISOString()).toBe(
      "2026-11-01T13:00:00.000Z",
    );
    expect(briefDue("2026-03-29", "08:00", "Europe/Berlin").toISOString()).toBe("2026-03-29T06:00:00.000Z");
  });

  it("lands just after the gap when the hour does not exist", () => {
    const at = briefDue("2026-03-08", "02:30", "America/New_York").getTime();
    expect(at).toBeGreaterThanOrEqual(Date.parse("2026-03-08T07:00:00.000Z"));
    expect(at).toBeLessThan(Date.parse("2026-03-08T08:00:00.000Z"));
  });
});

describe("the review budget", () => {
  const row = (id: string, minutes: number, must = false): AgendaItem => ({
    id,
    kind: "decision",
    title: id,
    why: "",
    action: "Open",
    target: { to: "decision", id },
    minutes,
    weight: 50,
    must,
  });

  it("fills today in order up to the budget and sends the rest to later", () => {
    const p = plan([row("a", 3), row("b", 3), row("c", 3), row("d", 3)], 9);
    expect(ids(p.today)).toEqual(["a", "b", "c"]);
    expect(ids(p.later)).toEqual(["d"]);
    expect(p).toMatchObject({ usedMinutes: 9, laterMinutes: 3, over: false });
  });

  it("stops at the first item that does not fit, so a small one never jumps the line", () => {
    const p = plan([row("big", 5), row("small", 1)], 3);
    // Nothing fits first, so the first is still today; the small one waits behind it.
    expect(ids(p.today)).toEqual(["big"]);
    expect(ids(p.later)).toEqual(["small"]);
    const q = plan([row("a", 2), row("big", 5), row("small", 1)], 4);
    expect(ids(q.today)).toEqual(["a"]);
    expect(ids(q.later)).toEqual(["big", "small"]);
  });

  it("keeps must items today past the budget and says it is over", () => {
    const p = plan([row("fire", 10, true), row("late", 10, true), row("a", 3), row("b", 3)], 15);
    expect(ids(p.today)).toEqual(["fire", "late"]);
    expect(ids(p.later)).toEqual(["a", "b"]);
    expect(p).toMatchObject({ usedMinutes: 20, over: true });
  });

  it("never shows an empty today while something waits", () => {
    const p = plan([row("a", 8), row("b", 8)], 5);
    expect(ids(p.today)).toEqual(["a"]);
    expect(p.over).toBe(true);
  });

  it("is empty when nothing needs the owner", () => {
    expect(plan([], 45)).toEqual({ today: [], later: [], usedMinutes: 0, laterMinutes: 0, over: false });
  });

  it("holds 60 decisions to the budget and counts the rest", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(`d${String(i).padStart(2, "0")}`, 2));
    const p = plan(rows, 45);
    expect(p.today).toHaveLength(22);
    expect(p.later).toHaveLength(38);
    expect(p.usedMinutes).toBe(44);
    expect(p.laterMinutes).toBe(76);
  });
});
