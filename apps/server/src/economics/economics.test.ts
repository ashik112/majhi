import { describe, expect, it } from "vitest";
import { DAY, daysAgo, desk, T0 } from "../growth/testing.ts";
import { flagsFor, isoWeek, valueFor, windows } from "./compute.ts";
import { economicsRunner } from "./playbook.ts";
import { EconomicsService } from "./service.ts";

/**
 * Client economics over a real in-memory store: what a week of shipped work, agent time and spend adds
 * up to, what the owner's rates make of it, and what is never made up.
 */

const MINUTES = { questions: 3, merge: 5, approvals: 1 };

function setup(rates: Record<string, { retainerUsd?: number; hourlyUsd?: number }> = {}) {
  const d = desk();
  const svc = new EconomicsService({
    db: d.store.raw,
    now: () => d.clock.at,
    tz: async () => "UTC",
    orgs: async () => ["acme", "globex", "private"],
    rates: () => new Map(Object.entries(rates)),
    minutes: () => MINUTES,
  });
  const turn = (at: Date, cost: number, org: string | null = "acme", task = "ACM-1") =>
    d.store.raw
      .prepare(
        `INSERT INTO turns (at, task, agent, account, tool, auth, org, input_tokens, output_tokens, reasoning_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, cost_source, estimated)
         VALUES (?, ?, 'builder', 'a', 'claude', 'oauth', ?, 100, 50, 0, 0, 0, ?, 'reported', 0)`,
      )
      .run(at.toISOString(), task, org, cost);
  const run = (task: string, start: Date, minutes: number | undefined) =>
    d.store.raw
      .prepare("INSERT INTO runs (task, agent, started_at, ended_at) VALUES (?, 'builder', ?, ?)")
      .run(
        task,
        start.toISOString(),
        minutes === undefined ? null : new Date(start.getTime() + minutes * 60_000).toISOString(),
      );
  const owner = (task: string, at: Date) =>
    d.store.raw
      .prepare(
        "INSERT INTO room_items (task, id, seq, type, payload, at) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM room_items WHERE task = ?), 'owner', '{}', ?)",
      )
      .run(task, `o-${Math.random()}`, task, at.toISOString());
  return { ...d, svc, turn, run, owner };
}

describe("the windows", () => {
  it("compares the last seven days with the seven before, and a month with the same days of the month before", () => {
    const w = windows("week", new Date("2026-10-09T15:00:00Z"), "UTC");
    expect(w).toMatchObject({
      from: "2026-10-02T15:00:00.000Z",
      previousFrom: "2026-09-25T15:00:00.000Z",
      previousTo: "2026-10-02T15:00:00.000Z",
      label: "Last 7 days",
    });
    const m = windows("month", new Date("2026-03-31T12:00:00Z"), "UTC");
    // March so far (31 days) against all of February: it is shorter, so it ends where March begins.
    expect(m).toMatchObject({
      from: "2026-03-01T00:00:00.000Z",
      previousFrom: "2026-02-01T00:00:00.000Z",
      previousTo: "2026-03-01T00:00:00.000Z",
      label: "March so far",
    });
    const early = windows("month", new Date("2026-10-04T00:00:00Z"), "UTC");
    expect(early.previousTo).toBe("2026-09-04T00:00:00.000Z");
  });

  it("a week of the retainer is a twelfth over fifty-two of it", () => {
    expect(valueFor(5_200, "week")).toBe(1_200);
    expect(valueFor(5_200, "month")).toBe(5_200);
    expect(valueFor(undefined, "week")).toBeUndefined();
  });

  it("names the ISO week", () => {
    expect(isoWeek(new Date("2026-10-09T15:00:00Z"))).toBe("2026-W41");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});

describe("the flags", () => {
  const base = {
    shipped: { now: 3, before: 3 },
    spentUsd: { now: 10, before: 10 },
    lastShippedAt: new Date(T0.getTime() - DAY).toISOString(),
    recentSpendUsd: 10,
    retainerUsd: undefined,
    monthSpendUsd: 10,
    now: T0,
  };
  it("flags spend that grows faster than shipped work, and only past a floor", () => {
    expect(flagsFor({ ...base, spentUsd: { now: 40, before: 10 } }).map((f) => f.kind)).toEqual([
      "spend-outpaces-work",
    ]);
    // Shipped work grew as much: no flag.
    expect(flagsFor({ ...base, spentUsd: { now: 40, before: 10 }, shipped: { now: 12, before: 3 } })).toEqual(
      [],
    );
    // A rise of three dollars is noise, even when it is 300 percent.
    expect(flagsFor({ ...base, spentUsd: { now: 4, before: 1 } })).toEqual([]);
  });

  it("flags a workspace with no shipped work in 14 days, but not one that never did anything", () => {
    const quiet = flagsFor({
      ...base,
      shipped: { now: 0, before: 0 },
      lastShippedAt: new Date(T0.getTime() - 20 * DAY).toISOString(),
    });
    expect(quiet.map((f) => f.kind)).toEqual(["quiet"]);
    expect(quiet[0]?.text).toBe("Nothing has shipped in 20 days.");
    expect(
      flagsFor({
        ...base,
        shipped: { now: 0, before: 0 },
        spentUsd: { now: 0, before: 0 },
        lastShippedAt: undefined,
        recentSpendUsd: 0,
        monthSpendUsd: 0,
      }),
    ).toEqual([]);
    // Money going out with nothing ever shipped is quiet too.
    expect(
      flagsFor({ ...base, shipped: { now: 0, before: 0 }, lastShippedAt: undefined, recentSpendUsd: 12 }).map(
        (f) => f.kind,
      ),
    ).toEqual(["quiet"]);
  });

  it("flags spend near the retainer, and never without one", () => {
    expect(flagsFor({ ...base, retainerUsd: 100, monthSpendUsd: 85 }).map((f) => f.kind)).toEqual([
      "near-budget",
    ]);
    expect(flagsFor({ ...base, retainerUsd: 100, monthSpendUsd: 50 })).toEqual([]);
    expect(flagsFor({ ...base, retainerUsd: undefined, monthSpendUsd: 5_000 })).toEqual([]);
  });
});

describe("the numbers", () => {
  it("adds up shipped work, agent time, spend and the owner's time, per workspace, against the week before", async () => {
    const t = setup();
    t.task("ACM-1", "Checkout", { status: "done" });
    t.task("ACM-2", "Export", { status: "done" });
    t.task("GLB-1", "Report", { org: "globex" });
    // This week: two tasks shipped in acme (one pushed and merged: it counts once).
    t.ship("ACM-1", daysAgo(2), { kind: "push" });
    t.ship("ACM-1", daysAgo(2), { kind: "merge" });
    t.ship("ACM-2", daysAgo(1));
    // Last week: one.
    t.ship("ACM-2", daysAgo(9));
    t.ship("GLB-1", daysAgo(3), { org: "globex" });
    t.run("ACM-1", daysAgo(3), 90);
    t.run("ACM-2", daysAgo(10), 30);
    t.turn(daysAgo(2), 4.5);
    t.turn(daysAgo(9), 1.5);
    t.turn(daysAgo(1), 2, "globex", "GLB-1");
    // The owner wrote twice to a task and merged twice.
    t.owner("ACM-1", daysAgo(2));
    t.owner("ACM-1", daysAgo(2));
    const out = await t.svc.get("week");
    const acme = out.rows.find((r) => r.org === "acme");
    expect(acme).toMatchObject({
      shipped: { now: 2, before: 1 },
      agentMinutes: { now: 90, before: 30 },
      spentUsd: { now: 4.5, before: 1.5 },
      // Two messages at 3 min, three owner ships at 5 min (a push and a merge are two).
      ownerMinutes: { now: 21, before: 5 },
    });
    expect(out.rows.find((r) => r.org === "globex")).toMatchObject({
      shipped: { now: 1, before: 0 },
      spentUsd: { now: 2, before: 0 },
    });
    expect(out.estimate).toMatch(/estimated/);
  });

  it("shows spend and work only when no rate is entered: no value, no margin, nothing invented", async () => {
    const t = setup();
    t.task("ACM-1", "Checkout");
    t.ship("ACM-1", daysAgo(1));
    t.turn(daysAgo(1), 7);
    const acme = (await t.svc.get("week", "acme")).rows[0];
    expect(acme).toMatchObject({ spentUsd: { now: 7 } });
    expect(acme?.valueUsd).toBeUndefined();
    expect(acme?.marginUsd).toBeUndefined();
    expect(acme?.ownerCostUsd).toBeUndefined();
    expect(acme?.retainerUsd).toBeUndefined();
  });

  it("with a retainer the week gets its share and the margin is value less spend and the owner's time", async () => {
    const t = setup({ acme: { retainerUsd: 5_200, hourlyUsd: 120 } });
    t.task("ACM-1", "Checkout");
    t.ship("ACM-1", daysAgo(1));
    t.turn(daysAgo(1), 100);
    t.owner("ACM-1", daysAgo(1));
    t.owner("ACM-1", daysAgo(1));
    t.owner("ACM-1", daysAgo(1));
    t.owner("ACM-1", daysAgo(1));
    t.owner("ACM-1", daysAgo(1));
    // 5 messages at 3 min and 1 ship at 5 min: 20 min, a third of an hour at $120.
    const acme = (await t.svc.get("week", "acme")).rows[0];
    expect(acme).toMatchObject({ valueUsd: 1_200, ownerCostUsd: 40, marginUsd: 1_060 });
    // An hourly rate alone gives the owner's cost and no margin.
    const only = setup({ acme: { hourlyUsd: 60 } });
    only.task("ACM-1", "Checkout");
    only.owner("ACM-1", daysAgo(1));
    const row = (await only.svc.get("week", "acme")).rows[0];
    expect(row?.ownerCostUsd).toBe(3);
    expect(row?.marginUsd).toBeUndefined();
  });

  it("a workspace with no activity shows zeros and no flags", async () => {
    const t = setup();
    const row = (await t.svc.get("week", "globex")).rows[0];
    expect(row).toMatchObject({
      org: "globex",
      shipped: { now: 0, before: 0 },
      agentMinutes: { now: 0, before: 0 },
      spentUsd: { now: 0, before: 0 },
      ownerMinutes: { now: 0, before: 0 },
      flags: [],
    });
  });

  it("does not count a chat as client work, another workspace's rows, or a run left open for a day as a day of work", async () => {
    const t = setup();
    t.task("ACM-1", "Checkout");
    t.task("CHAT-1", "Talking to the captain", { kind: "chat" });
    t.run("CHAT-1", daysAgo(1), 600);
    t.owner("CHAT-1", daysAgo(1));
    // A run that never closed, started two days ago, counts at most 12 hours.
    t.run("ACM-1", daysAgo(2), undefined);
    const acme = (await t.svc.get("week", "acme")).rows[0];
    expect(acme?.agentMinutes.now).toBe(720);
    expect(acme?.ownerMinutes.now).toBe(0);
  });

  it("ships through the whole month so far against the same days last month", async () => {
    const t = setup();
    t.task("ACM-1", "Checkout");
    t.ship("ACM-1", new Date("2026-10-03T10:00:00Z"));
    t.ship("ACM-1", new Date("2026-09-03T10:00:00Z"));
    t.ship("ACM-1", new Date("2026-09-20T10:00:00Z"));
    const out = await t.svc.get("month", "acme");
    expect(out.label).toBe("October so far");
    // 9 days of October against the first 9 days of September: the 20th is outside it.
    expect(out.rows[0]?.shipped).toEqual({ now: 1, before: 1 });
  });
});

describe("the weekly playbook", () => {
  async function runner() {
    const t = setup({ acme: { retainerUsd: 100 } });
    t.task("ACM-1", "Checkout");
    // Spend is near the retainer and rose; nothing shipped for a month.
    t.ship("ACM-1", daysAgo(30));
    t.turn(daysAgo(2), 90);
    t.turn(daysAgo(9), 5);
    const economics = economicsRunner(t.svc, async (org) => (org === "acme" ? "Acme" : org));
    const run = () => economics.run(t.ctx("biz-economics"));
    return { t, run };
  }

  it("files one analysis finding per flag, once per week", async () => {
    const { t, run } = await runner();
    const first = await run();
    expect(first.findings).toBe(3);
    const all = t.findings.list({ org: "acme", source: "analysis", limit: 50 }, { kind: "owner" }).findings;
    expect(all.map((f) => f.title).sort()).toEqual([
      "Acme: nothing has shipped in two weeks",
      "Acme: spend is growing faster than shipped work",
      "Acme: spend is near the retainer",
    ]);
    expect(
      all.every((f) => f.dedupeKey.startsWith("economics:acme:") && f.dedupeKey.endsWith("2026-W41")),
    ).toBe(true);
    // A second run the same week adds nothing.
    await run();
    expect(
      t.findings.list({ org: "acme", source: "analysis", limit: 50 }, { kind: "owner" }).findings,
    ).toHaveLength(3);
  });

  it("folds last week's finding into this week's while the flag holds, and closes it when the flag clears", async () => {
    const { t, run } = await runner();
    await run();
    t.clock.at = new Date(T0.getTime() + 7 * DAY);
    t.turn(new Date(T0.getTime() + 5 * DAY), 1);
    await run();
    const list = () =>
      t.findings.list({ org: "acme", source: "analysis", limit: 50 }, { kind: "owner" }).findings;
    const live = list().filter((f) => f.status === "open");
    // Spend is still near the retainer this week and the work is still quiet; the growth flag is gone.
    expect(live.map((f) => f.dedupeKey.split(":")[2]).sort()).toEqual(["near-budget", "quiet"]);
    const old = list().filter((f) => f.dedupeKey.endsWith("W41"));
    expect(old.find((f) => f.dedupeKey.includes("spend-outpaces"))?.status).toBe("fixed");
    expect(old.find((f) => f.dedupeKey.includes("near-budget"))?.status).toBe("dismissed");
    expect(old.find((f) => f.dedupeKey.includes("near-budget"))?.dismissedReason).toMatch(/^Folded into/);
  });

  it("files nothing for a workspace with nothing to flag, and says what the week was", async () => {
    const t = setup();
    t.task("ACM-1", "Checkout");
    t.ship("ACM-1", daysAgo(1));
    t.turn(daysAgo(1), 3);
    const out = await economicsRunner(t.svc, async () => "Acme").run(t.ctx("biz-economics"));
    expect(out.findings).toBe(0);
    expect(out.note).toBe("Nothing to flag: 1 shipped, 0 min of agent work, $3.00, your time about 5 min");
  });
});
