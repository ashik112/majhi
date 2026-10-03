import type { AutonomyEvent, AutonomySummary } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import type { Harness } from "../testing/harness.ts";
import { UsageRepo } from "../usage/repo.ts";
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
    expect(
      (
        await h.cmd("autonomy.configure", {
          tz: "UTC",
          summary_at: "08:00",
          orgs: { acme: { level: "runs" } },
        })
      ).status,
    ).toBe(200);
    expect((await h.cmd("autonomy.start")).body.mode).toBe("on");
    const autonomy = h.majhi.services.autonomy;
    const lane = (await autonomy.laneChat("acme")) ?? "";
    // Turned on after today's 08:00: the day before had no autonomous mode, so no summary yet.
    expect(await autonomy.dailySummary()).toBe(undefined);

    now = new Date("2026-10-02T07:59:00.000Z");
    expect(await autonomy.dailySummary()).toBe(undefined);
    now = new Date("2026-10-02T08:00:30.000Z");
    const made = (await autonomy.dailySummary()) as AutonomySummary;
    // Made on the 2nd about the 1st: the day it covers, midnight to midnight.
    expect(made).toMatchObject({
      day: "2026-10-01",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
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
    // Said in the lane of each workspace set to Runs it.
    const lines = (await w.items(lane)).flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(lines.filter((l) => l.startsWith("Daily summary for 2026-10-01"))).toHaveLength(1);
  });

  it("compares the day's spend against the cap that applied that day, and says when it moved", async () => {
    let now = new Date("2026-10-01T10:00:00.000Z");
    w = await bossWorld({ real: false, runClock: () => now });
    const { h } = w;
    const configure = async (patch: object) =>
      expect((await h.cmd("autonomy.configure", patch)).status).toBe(200);
    await configure({
      tz: "UTC",
      summary_at: "08:00",
      day: { cost: 200 },
      orgs: { acme: { level: "runs" } },
    });
    expect((await h.cmd("autonomy.start")).body.mode).toBe("on");
    const autonomy = h.majhi.services.autonomy;
    const lane = (await autonomy.laneChat("acme")) ?? "";
    const turns = new UsageRepo(h.majhi.services.store.raw);
    const spend = (at: string, cost: number) =>
      turns.insert({
        at,
        task: lane,
        agent: "boss",
        account: "claude-acme",
        tool: "claude",
        auth: "login",
        org: "acme",
        project: null,
        runId: null,
        model: "sonnet",
        inputTokens: 1000,
        outputTokens: 100,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: cost,
        costSource: "reported",
        estimated: true,
      });
    spend("2026-10-01T12:00:00.000Z", 80.56);

    // The owner lowers the cap early the next morning, before the summary of the 1st is made.
    now = new Date("2026-10-02T05:04:00.000Z");
    await configure({ day: { cost: 50 } });
    now = new Date("2026-10-02T08:00:30.000Z");
    const first = (await autonomy.dailySummary()) as AutonomySummary;
    expect(first.day).toBe("2026-10-01");
    expect(first.spent.total).toMatchObject({ used: { cost: 80.56 }, cap: { cost: 200 }, reached: false });
    expect(first.spent.total.changed).toBeUndefined();
    expect(summaryLine(first)).toBe("Daily summary for 2026-10-01: shipped 0, spent $80.56 of $200.00.");

    // On the 2nd the cap moves again during the day: the summary says so.
    spend("2026-10-02T09:00:00.000Z", 10);
    now = new Date("2026-10-02T20:00:00.000Z");
    await configure({ day: { cost: 30 } });
    now = new Date("2026-10-03T08:00:30.000Z");
    const second = (await autonomy.dailySummary()) as AutonomySummary;
    expect(second.day).toBe("2026-10-02");
    expect(second.spent.total).toMatchObject({ used: { cost: 10 }, cap: { cost: 30 }, changed: true });
    expect(summaryLine(second)).toBe(
      "Daily summary for 2026-10-02: shipped 0, spent $10.00 (the cap changed during the day, to $30.00).",
    );
  });
});
