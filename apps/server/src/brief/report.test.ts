import { describe, expect, it } from "vitest";
import { world } from "../chat/testing/world.ts";
import { quietWeek, reportFacts, reportTexts, type WeekRows } from "./report.ts";
import { ReportService } from "./report-service.ts";

/**
 * Test 8: the weekly client report. Acme's week from fixture rows gives literal numbers; a week with nothing makes
 * nothing; the client copy never holds another workspace's name or, with "Show cost to client" off, the cost; and
 * under Ask me nothing reaches the client until the owner sends it.
 */

const WEEK = "2026-10-12";
const FROM = "2026-10-12T00:00:00.000Z";
const TO = "2026-10-19T00:00:00.000Z";

const ROWS: WeekRows = {
  shipped: [
    { task: "ACM-1", title: "Fix the login page" },
    { task: "ACM-2", title: "Globex style import" },
    { task: "ACM-3", title: "Speed up checkout" },
    { task: "ACM-4", title: "Update the footer" },
  ],
  // 5 h + 4 h + 3.5 h
  runs: [
    { startedAt: "2026-10-12T08:00:00.000Z", endedAt: "2026-10-12T13:00:00.000Z" },
    { startedAt: "2026-10-14T08:00:00.000Z", endedAt: "2026-10-14T12:00:00.000Z" },
    { startedAt: "2026-10-15T08:00:00.000Z", endedAt: "2026-10-15T11:30:00.000Z" },
  ],
  cost: 18.4,
  incidents: [
    // 20 minutes, then 18 minutes: 38 of 10,080 minutes failing.
    { openedAt: "2026-10-13T10:00:00.000Z", resolvedAt: "2026-10-13T10:20:00.000Z", timeline: [] },
    { openedAt: "2026-10-16T09:00:00.000Z", resolvedAt: "2026-10-16T09:18:00.000Z", timeline: [] },
  ],
  monitored: true,
};

const facts = () => reportFacts({ org: "acme", orgName: "Acme", week: WEEK, from: FROM, to: TO, rows: ROWS });

describe("the weekly client report", () => {
  it("gives Acme's week as literal numbers, and the client copy has no cost by default and no other workspace", () => {
    const f = facts();
    expect([f.shipped, f.hours, f.cost, f.incidents, f.uptime]).toEqual([4, 12.5, 18.4, 2, 99.62]);
    const off = reportTexts(f, false);
    expect(off.client).toBe(
      [
        "Weekly report for Acme, 12 Oct to 18 Oct.",
        "Shipped: 4 changes.",
        "Agent work: 12.5 hours.",
        "Incidents: 2. Uptime: 99.62%.",
      ].join("\n"),
    );
    expect(off.client).not.toContain("$");
    expect(off.client).not.toContain("Globex");
    // The internal copy says everything, titles and cost included.
    expect(off.internal).toContain("Agent cost: $18.40.");
    expect(off.internal).toContain("Globex style import");
    // With the switch on the client reads the cost, and still no title.
    const on = reportTexts(f, true);
    expect(on.client).toContain("Agent cost: $18.40.");
    expect(on.client).not.toContain("Globex");
  });

  it("makes nothing for a week with nothing in it", async () => {
    const quiet = reportFacts({
      org: "acme",
      orgName: "Acme",
      week: WEEK,
      from: FROM,
      to: TO,
      rows: { shipped: [], runs: [], cost: 0, incidents: [], monitored: false },
    });
    expect(quietWeek(quiet)).toBe(true);
    expect(quiet.uptime).toBeUndefined();
  });

  it("holds the report under Ask me until the owner sends it, and under Captain sends still holds a secret or another client's name", async () => {
    const t = world({ tell: "decide", holds: { firstContact: false } });
    const room = await t.linked();
    const client = reportTexts(facts(), false).client;

    const asked = await t.replies.captain({ room, text: client, weekly: "ask" });
    expect(asked).toMatchObject({ state: "held", why: "report" });
    expect(t.sent).toEqual([]);
    const draft = t.gate.list("acme")[0];
    expect(draft?.status).toBe("pending");
    expect(t.store.room.get(room, `reply:${draft?.id}`)).toMatchObject({ weekly: true, state: "held" });

    const sends = await t.replies.captain({ room, text: client, weekly: "sends" });
    expect(sends).toMatchObject({ state: "sent" });
    expect(t.sent.map((s) => s.text)).toEqual([client]);

    const leak = await t.replies.captain({ room, text: `${client}\nGlobex had this too.`, weekly: "sends" });
    expect(leak).toMatchObject({ state: "held", why: "other-client" });
    expect(t.sent).toHaveLength(1);
  });

  it("goes only to the chats that get it, once a week, and a quiet week makes no report at all", async () => {
    const w = world({ tell: "decide" });
    const gets = await w.linked("-100");
    const skips = await w.linked("-200");
    const seen: { room: string; mode: string }[] = [];
    const internal: string[] = [];
    const claims = new Set<string>();
    let rows: WeekRows = ROWS;
    const service = new ReportService({
      repo: {
        claim: (week: string, org: string) => {
          const key = `${week}:${org}`;
          if (claims.has(key)) return false;
          claims.add(key);
          return true;
        },
        rows: () => rows,
      } as never,
      clock: async () => ({ at: "08:00", tz: "UTC" }),
      orgs: async () => [{ id: "acme", name: "Acme" }],
      clientUpdate: async () => "ask",
      showCost: async () => false,
      rooms: () => [
        { room: gets, weekly: true },
        { room: skips, weekly: false },
      ],
      send: async (room, _org, text, mode) => {
        seen.push({ room, mode });
        await w.replies.captain({ room, text, weekly: mode });
      },
      internal: async (_org, _week, text) => {
        internal.push(text);
      },
      // Monday 19 October, after 08:00.
      now: () => new Date("2026-10-19T08:30:00.000Z"),
    });
    await service.sweep();
    await service.sweep();
    expect(seen).toEqual([{ room: gets, mode: "ask" }]);
    expect(internal).toHaveLength(1);
    expect(w.sent).toEqual([]);

    // The next week has nothing: it is claimed, and nothing is made or sent.
    rows = { shipped: [], runs: [], cost: 0, incidents: [], monitored: false };
    const later = new ReportService({
      repo: {
        claim: () => true,
        rows: () => rows,
      } as never,
      clock: async () => ({ at: "08:00", tz: "UTC" }),
      orgs: async () => [{ id: "acme", name: "Acme" }],
      clientUpdate: async () => "ask",
      showCost: async () => false,
      rooms: () => [{ room: gets, weekly: true }],
      send: async () => {
        throw new Error("a quiet week sends nothing");
      },
      internal: async () => {
        throw new Error("a quiet week makes no report");
      },
      now: () => new Date("2026-10-26T09:00:00.000Z"),
    });
    await later.sweep();
  });
});
