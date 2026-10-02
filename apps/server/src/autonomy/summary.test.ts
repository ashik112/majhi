import type { AutonomyEvent, AutonomySummary } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import type { Harness } from "../testing/harness.ts";
import { buildSummary, summaryLine } from "./summary.ts";

describe("buildSummary", () => {
  let seq = 0;
  const event = (e: Omit<AutonomyEvent, "seq" | "at">): AutonomyEvent => ({
    seq: ++seq,
    at: "2026-10-01T12:00:00.000Z",
    ...e,
  });

  it("says how far each task went, what it is unsure about, and how many decisions it logged", () => {
    const events = [
      event({ kind: "task", text: "ACM-1 is ready for review", task: "ACM-1", status: "review" }),
      event({
        kind: "approval",
        text: "Approved: merge ACM-1",
        task: "ACM-1",
        command: "tasks.merge",
        outcome: "applied",
      }),
      event({
        kind: "decision",
        text: "Push ACM-2",
        task: "ACM-2",
        command: "tasks.push",
        outcome: "applied",
      }),
      event({
        kind: "decision",
        text: "Push ACM-4",
        task: "ACM-4",
        command: "tasks.push",
        outcome: "failed",
      }),
      event({ kind: "task", text: "ACM-3 is done", task: "ACM-3", status: "done" }),
      event({ kind: "task", text: "ACM-5 is running", task: "ACM-5", status: "running" }),
      event({ kind: "decision", text: "Waiting for Globex's reset", unsure: true }),
      event({
        kind: "refused",
        text: "Create task: secret:x belongs to Globex",
        task: "ACM-1",
        outcome: "refused",
      }),
      event({
        kind: "approval",
        text: "Left for the owner: remove ACM-9",
        outcome: "left",
        item: "approval:1",
      }),
    ];
    const summary = buildSummary({
      day: "2026-10-02",
      from: "2026-10-01T08:00:00.000Z",
      to: "2026-10-02T08:00:00.000Z",
      at: "2026-10-02T08:00:10.000Z",
      events,
      tasks: new Map([
        ["ACM-1", { title: "Fix login", org: "acme" }],
        ["ACM-2", { title: "Add a test", org: "acme" }],
      ]),
      spent: {
        total: { used: { tokens: 5000, cost: 4.2 }, cap: { cost: 20 }, percent: 21, reached: false },
        orgs: [],
      },
      waiting: [
        {
          task: "LOCAL-1",
          item: "approval:1",
          kind: "approval",
          text: "Remove ACM-9",
          why: "Only the owner removes things",
        },
      ],
    });
    expect(summary.shipped).toEqual([
      { task: "ACM-1", title: "Fix login", org: "acme", how: "merged" },
      { task: "ACM-2", title: "Add a test", org: "acme", how: "pushed" },
      { task: "ACM-3", title: "ACM-3", how: "done" },
    ]);
    expect(summary.unsure.map((u) => u.text)).toEqual([
      "Waiting for Globex's reset",
      "Refused: Create task: secret:x belongs to Globex",
    ]);
    expect(summary.decisions).toBe(5);
    expect(summaryLine(summary)).toBe(
      "Daily summary for 2026-10-02: shipped 3, spent $4.20 of $20.00, unsure about 2, 1 waiting for you.",
    );
  });
});

describe("the daily summary", () => {
  let w: BossWorld | undefined;
  let extra: Harness | undefined;
  afterEach(async () => {
    await extra?.majhi.close();
    extra = undefined;
    await w?.cleanup();
    w = undefined;
  });

  it("is made once a day at its time, only after a day the mode was on, and once across restarts", async () => {
    let now = new Date("2026-10-01T10:00:00.000Z");
    w = await bossWorld({ real: false, runClock: () => now });
    const { h } = w;
    expect((await h.cmd("autonomy.configure", { tz: "UTC", summary_at: "08:00" })).status).toBe(200);
    expect((await h.cmd("autonomy.start")).body.mode).toBe("on");
    const autonomy = h.majhi.services.autonomy;
    // Turned on after today's 08:00: the day before had no autonomous mode, so no summary yet.
    expect(await autonomy.dailySummary()).toBe(undefined);

    now = new Date("2026-10-02T07:59:00.000Z");
    expect(await autonomy.dailySummary()).toBe(undefined);
    now = new Date("2026-10-02T08:00:30.000Z");
    const made = (await autonomy.dailySummary()) as AutonomySummary;
    expect(made).toMatchObject({
      day: "2026-10-02",
      from: "2026-10-01T08:00:00.000Z",
      to: "2026-10-02T08:00:00.000Z",
    });
    expect(await autonomy.dailySummary()).toBe(undefined);
    expect((await h.cmd("autonomy.status")).body.summary).toEqual(made);

    // A restart the same day makes no second one.
    extra = h.restart();
    expect(await extra.majhi.services.autonomy.dailySummary()).toBe(undefined);
    const summaries = (await h.cmd("autonomy.events", { limit: 100 })).body.events.filter(
      (e: AutonomyEvent) => e.kind === "summary",
    );
    expect(summaries).toHaveLength(1);
    const chat = autonomy.chat() ?? "";
    const lines = (await w.items(chat)).flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(lines.filter((l) => l.startsWith("Daily summary for 2026-10-02"))).toHaveLength(1);
  });
});
