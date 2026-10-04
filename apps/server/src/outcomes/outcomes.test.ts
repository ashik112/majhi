import { ALL_ASK, type Authority, type AuthorityRow, type Cadence, type OwnerDecision } from "@majhi/shared";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CaptainRepo } from "../captain/repo.ts";
import { OutboundGate } from "../playbooks/outbound.ts";
import { Store } from "../store/index.ts";
import { monthWindow } from "./money.ts";
import { OutcomesService } from "./service.ts";

/**
 * The outcomes pass, the scorecard, the trust ladder and the monthly ceiling over a real in-memory
 * store. Rows are written the way the captain writes them (its log, its undo, drafts, findings); the
 * clock is ours.
 */

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-04T08:00:00.000Z");

interface Desk {
  svc: OutcomesService;
  db: Database.Database;
  log: CaptainRepo;
  clock: { at: number };
  authority: Authority;
  authorityCalls: [string, AuthorityRow, string][];
  cadence: { value: Cadence; enabled: boolean };
  cadenceCalls: Cadence[];
  gate: OutboundGate;
  tz: { value: string };
  action(
    i: number,
    at: number,
    over?: { chore?: "ship" | "triage" | "cards" | "questions"; key?: string; task?: string },
  ): number;
  undo(id: number, at: number): void;
  finding(i: number, playbook: string, status: string, at: number): void;
  draft(i: number, channel: string, status: string, at: number, mode?: string): void;
  turn(at: number, cost: number, org?: string, task?: string): void;
}

function desk(over: { window?: number; authority?: Partial<Authority> } = {}): Desk {
  const store = new Store(":memory:");
  const db = store.raw;
  const clock = { at: T0 };
  const authority: Authority = { ...ALL_ASK, ...over.authority };
  const authorityCalls: [string, AuthorityRow, string][] = [];
  const cadence = { value: { kind: "daily", at: "00:00" } as Cadence, enabled: true };
  const cadenceCalls: Cadence[] = [];
  const tz = { value: "UTC" };
  const gate = new OutboundGate({
    db,
    now: () => new Date(clock.at),
    tz: async () => "UTC",
    knownOrg: async () => true,
    autoAllowed: (org, channel) => svcRef.current?.autoAccepted(org, channel) ?? false,
  });
  const svcRef: { current: OutcomesService | undefined } = { current: undefined };
  const svc = new OutcomesService({
    db,
    now: () => new Date(clock.at),
    tz: async () => tz.value,
    orgs: async () => ["acme", "globex"],
    orgName: async (org) => (org === "acme" ? "Acme" : "Globex"),
    playbookOfChore: (chore) => (chore === "followups" ? "followups" : undefined),
    authority: async () => ({ ...authority }),
    setAuthority: async (org, row, choice, reason) => {
      authority[row] = choice;
      authorityCalls.push([org, row, reason]);
    },
    outbound: {
      mode: (org, channel) => gate.mode(org, channel),
      applyLadder: (org, channel, mode) => gate.applyLadder(org, channel, mode),
    },
    playbooks: {
      name: (id) => (id === "deps" ? "Dependency check" : id),
      state: (_org, id) => (id === "deps" ? { cadence: cadence.value, enabled: cadence.enabled } : undefined),
      setCadence: async (_org, _id, c) => {
        cadence.value = c;
        cadenceCalls.push(c);
      },
    },
    window: over.window ?? 20,
  });
  svcRef.current = svc;
  const log = new CaptainRepo(db);
  return {
    svc,
    db,
    log,
    clock,
    authority,
    authorityCalls,
    cadence,
    cadenceCalls,
    gate,
    tz,
    action(i, at, o = {}) {
      const id = log.addAction({
        key: o.key ?? `k:${i}`,
        org: "acme",
        chore: o.chore ?? "ship",
        day: new Date(at).toISOString().slice(0, 10),
        at: new Date(at).toISOString(),
        text: `Shipped ACM-${i} to main`,
        reason: "checks passed",
        ...(o.task === undefined ? {} : { task: o.task }),
        outcome: "done",
        undoNote: "test",
      });
      if (id === undefined) throw new Error("duplicate key");
      return id;
    },
    undo(id, at) {
      log.markUndone(id, new Date(at).toISOString());
    },
    finding(i, playbook, status, at) {
      db.prepare(
        `INSERT INTO findings (org, source, title, severity, playbook, dedupe_key, status, by, created_at, updated_at, last_seen)
         VALUES ('acme', 'dependency', ?, 'low', ?, ?, ?, 'captain', ?, ?, ?)`,
      ).run(
        `Finding ${i}`,
        playbook,
        `k${i}`,
        status,
        new Date(at).toISOString(),
        new Date(at).toISOString(),
        new Date(at).toISOString(),
      );
    },
    draft(i, channel, status, at, mode = "draft") {
      db.prepare(
        `INSERT INTO outbound_drafts (org, channel, target, body, status, mode, by, created_at, decided_at)
         VALUES ('acme', ?, ?, 'Hello', ?, ?, 'captain', ?, ?)`,
      ).run(
        channel,
        `ana${i}@globex.example`,
        status,
        mode,
        new Date(at).toISOString(),
        new Date(at).toISOString(),
      );
    },
    turn(at, cost, org = "acme", task = "ACM-1") {
      db.prepare(
        `INSERT INTO turns (at, task, agent, account, tool, auth, org, input_tokens, output_tokens, reasoning_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, cost_source, estimated)
         VALUES (?, ?, 'acme-builder', 'claude-acme', 'claude', 'oauth', ?, 1000, 500, 0, 0, 0, ?, 'reported', 0)`,
      ).run(new Date(at).toISOString(), task, org, cost);
    },
  };
}

const result = (d: Desk, subject: string) => d.svc.repo.get(subject)?.result;

describe("outcomes of the captain's actions", () => {
  it("counts an action kept only after the wait, and an undo an hour later wins over waiting", async () => {
    const d = desk();
    const early = d.action(1, T0);
    d.clock.at = T0 + HOUR;
    d.undo(early, T0 + HOUR);
    await d.svc.sweep();
    expect(result(d, `action:${early}`)).toBe("merged-reverted");
    // Another action nobody touched: pending at one hour, kept after six.
    const other = d.action(2, T0);
    d.clock.at = T0 + 2 * HOUR;
    await d.svc.sweep();
    expect(result(d, `action:${other}`)).toBeUndefined();
    d.clock.at = T0 + 7 * HOUR;
    await d.svc.sweep();
    expect(result(d, `action:${other}`)).toBe("kept");
  });

  it("flips a kept action to undone when the owner undoes it a day later, and counts it once", async () => {
    const d = desk();
    // A Tuesday, so the whole story sits in one week.
    const t = Date.parse("2026-10-06T08:00:00.000Z");
    const id = d.action(1, t, { chore: "triage", key: "triage:priority:ACM-1:x" });
    d.clock.at = t + 24 * HOUR;
    await d.svc.sweep();
    expect(result(d, `action:${id}`)).toBe("kept");
    d.undo(id, t + 30 * HOUR);
    d.clock.at = t + 31 * HOUR;
    await d.svc.sweep();
    await d.svc.sweep();
    expect(result(d, `action:${id}`)).toBe("undone");
    const card = await d.svc.scorecard("week", "acme");
    expect(card.total).toMatchObject({ actions: 1, judged: 1, kept: 0, overruled: 1, keptPct: 0 });
    // Triage is upkeep: the row carries it.
    expect(card.rows.find((r) => r.key === "upkeep")?.tally.actions).toBe(1);
  });

  it("keeps an action whose task was deleted, and voids a started task that vanished unjudged", async () => {
    const d = desk();
    // The action names a task that is not in the tasks table at all.
    const id = d.action(1, T0, { task: "ACM-404" });
    d.db
      .prepare(
        "INSERT INTO autonomy_events (at, kind, text, task, org) VALUES (?, 'task', 'Started ACM-9: Fix the export', 'ACM-9', 'acme')",
      )
      .run(new Date(T0).toISOString());
    d.clock.at = T0 + 8 * HOUR;
    await d.svc.sweep();
    expect(result(d, `action:${id}`)).toBe("kept");
    expect(result(d, "start:ACM-9")).toBe("void");
    const card = await d.svc.scorecard("week", "acme");
    // The void start is neither an action nor a judgment: only the kept action shows.
    expect(card.total).toMatchObject({ actions: 1, judged: 1, kept: 1, keptPct: 100 });
  });

  it("marks a started task failed when it paused after an error, and kept when it finished", async () => {
    const d = desk();
    const ins = (text: string, task: string, status: string | null, at: number) =>
      d.db
        .prepare(
          "INSERT INTO autonomy_events (at, kind, text, task, org, status) VALUES (?, 'task', ?, ?, 'acme', ?)",
        )
        .run(new Date(at).toISOString(), text, task, status);
    d.db
      .prepare(
        "INSERT INTO tasks (id, title, brief, kind, org, status, folder, team, created_at, updated_at) VALUES ('ACM-1', 'One', '', 'task', 'acme', 'paused', 'f', '[]', ?, ?), ('ACM-2', 'Two', '', 'task', 'acme', 'done', 'f', '[]', ?, ?)",
      )
      .run("x", "x", "x", "x");
    ins("Started ACM-1: One", "ACM-1", null, T0);
    ins("Paused 'One' because the agent hit an error", "ACM-1", "paused", T0 + HOUR);
    ins("Created ACM-2: Two", "ACM-2", null, T0);
    ins("'Two' is done", "ACM-2", "done", T0 + 2 * HOUR);
    d.clock.at = T0 + 3 * HOUR;
    await d.svc.sweep();
    expect(result(d, "start:ACM-1")).toBe("task-failed");
    expect(result(d, "start:ACM-2")).toBe("kept");
  });

  it("reads the owner's 'Wrong?' mark on a Laya decision as an overrule of the action it led to", async () => {
    const d = desk();
    const id = d.log.addAction({
      key: "k:laya",
      org: "acme",
      chore: "triage",
      day: "2026-10-04",
      at: new Date(T0).toISOString(),
      text: "Set ACM-3 to high priority",
      reason: "due soon",
      decision: "dec_abc",
      outcome: "done",
    });
    d.db
      .prepare(
        "INSERT INTO decisions (id, at, use, summary, provider, answers, estimated, duration_ms) VALUES ('dec_abc', ?, 'task-size', 's', 'laya', '{}', 0, 1)",
      )
      .run(new Date(T0).toISOString());
    d.db
      .prepare(
        "INSERT INTO decision_labels (decision_id, use, question, label, source, at) VALUES ('dec_abc', 'task-size', 'size', 'small', 'owner', ?)",
      )
      .run(new Date(T0).toISOString());
    d.clock.at = T0 + HOUR;
    await d.svc.sweep();
    expect(result(d, `action:${id}`)).toBe("overruled");
  });

  it("records an answer against the captain's recommendation as overruled, and one that follows it as accepted", () => {
    const d = desk();
    const decision = (
      id: string,
      option: string,
    ): Pick<OwnerDecision, "id" | "kind" | "org" | "task" | "suggestion"> => ({
      id,
      kind: "ship",
      org: "acme",
      task: "ACM-5",
      suggestion: { option, reason: "checks passed", by: "captain" },
    });
    d.svc.answered(decision("room:ACM-5:a", "merge"), "merge");
    d.svc.answered(decision("room:ACM-6:a", "merge"), "changes");
    // An agent's suggestion is not the captain's opinion: nothing is recorded.
    d.svc.answered(
      { ...decision("room:ACM-7:a", "merge"), suggestion: { option: "merge", reason: "r", by: "agent" } },
      "done",
    );
    expect(d.svc.repo.get("rec:room:ACM-5:a")?.result).toBe("accepted");
    expect(d.svc.repo.get("rec:room:ACM-6:a")?.result).toBe("overruled");
    expect(d.svc.repo.get("rec:room:ACM-7:a")).toBeUndefined();
  });
});

describe("the scorecard", () => {
  it("has no percent and no NaN with zero actions", async () => {
    const d = desk();
    const card = await d.svc.scorecard("today");
    expect(card.total).toMatchObject({
      actions: 0,
      judged: 0,
      kept: 0,
      pending: 0,
      tokens: 0,
      costUsd: 0,
      minutesSaved: 0,
    });
    expect(card.total.keptPct).toBeUndefined();
    expect(card.total.overruledPct).toBeUndefined();
    expect(card.orgs).toEqual([]);
    expect(JSON.stringify(card)).not.toMatch(/NaN|Infinity/);
  });

  it("sums actions, kept percent, cost and minutes saved per workspace, row and playbook", async () => {
    const d = desk();
    for (let i = 1; i <= 4; i++) d.action(i, T0 - 7 * HOUR);
    const bad = d.action(5, T0 - 7 * HOUR);
    d.undo(bad, T0 - 6 * HOUR);
    d.action(6, T0 - 7 * HOUR, { chore: "cards", key: "own:ACM-1:p1" });
    d.turn(T0 - 5 * HOUR, 2.5);
    d.finding(1, "deps", "task", T0 - 2 * HOUR);
    d.finding(2, "deps", "dismissed", T0 - 2 * HOUR);
    d.finding(3, "deps", "open", T0 - 2 * HOUR);
    // The lane's own turns are the captain's cost.
    d.db.prepare("INSERT INTO captain_lanes (org, chat, created_at) VALUES ('acme', 'CHAT-1', 'x')").run();
    d.turn(T0 - 3 * HOUR, 0.6, "acme", "CHAT-1");
    await d.svc.sweep();
    const card = await d.svc.scorecard("week", "acme");
    const acme = card.orgs.find((o) => o.org === "acme");
    expect(acme?.tally).toMatchObject({
      actions: 6,
      judged: 6,
      kept: 5,
      overruled: 1,
      keptPct: 83.3,
      overruledPct: 16.7,
      costUsd: 0.6,
    });
    // 4 merges at 5 min and one own-work approval at 1 min, plus one finding taken at 15 min.
    expect(acme?.tally.minutesSaved).toBe(36);
    expect(acme?.findings).toEqual({ filed: 3, accepted: 1, dismissed: 1, conversionPct: 50 });
    expect(acme?.line).toBe("Kept 5/6, $0.60, ~36 min saved");
    expect(card.rows.map((r) => [r.key, r.tally.actions]).sort()).toEqual([
      ["merge", 5],
      ["own", 1],
    ]);
    expect(card.playbooks.find((p) => p.playbook === "deps")?.findings).toMatchObject({
      filed: 3,
      accepted: 1,
      dismissed: 1,
    });
  });

  it("uses the minutes the owner set, and the default again when cleared", async () => {
    const d = desk();
    d.action(1, T0 - 7 * HOUR);
    await d.svc.sweep();
    expect((await d.svc.scorecard("today")).total.minutesSaved).toBe(5);
    d.svc.setMinutes("merge", 20);
    expect((await d.svc.scorecard("today")).total.minutesSaved).toBe(20);
    d.svc.setMinutes("merge", undefined);
    expect((await d.svc.scorecard("today")).total.minutesSaved).toBe(5);
  });

  it("keeps today and the week apart", async () => {
    const d = desk();
    // T0 is a Sunday: the week started Monday the 28th.
    d.action(1, Date.parse("2026-09-29T10:00:00.000Z"));
    d.action(2, T0 - HOUR);
    d.clock.at = T0 + 12 * HOUR;
    await d.svc.sweep();
    expect((await d.svc.scorecard("today")).total.actions).toBe(1);
    expect((await d.svc.scorecard("week")).total.actions).toBe(2);
  });
});

let seq = 100;

/** Fills a row with judged ship actions: `kept` kept and the rest undone. */
async function fill(d: Desk, kept: number, undone: number, from = T0 - 100 * HOUR) {
  for (let k = 0; k < kept + undone; k++) {
    const at = from + k * 60_000;
    const id = d.action(++seq, at);
    if (k >= kept) d.undo(id, at + 5 * 60_000);
  }
  d.clock.at = T0;
  await d.svc.sweep();
}

describe("the trust ladder: demotion", () => {
  it("leaves a row alone at exactly 80 percent and drops it below", async () => {
    const at = desk({ authority: { merge: "decide" } });
    await fill(at, 16, 4);
    expect(at.authority.merge).toBe("decide");
    expect(at.svc.decisions()).toEqual([]);

    const below = desk({ authority: { merge: "decide" } });
    await fill(below, 15, 5);
    expect(below.authority.merge).toBe("ask");
    expect(below.authorityCalls).toHaveLength(1);
    const [item] = below.svc.decisions();
    expect(item).toMatchObject({ kind: "trust", org: "acme" });
    expect(item?.title).toBe("Acme: Merge went back to You. Only 15 of the last 20 were kept (75%).");
    expect(item?.sentence).toContain("Shipped ACM-");
    expect(item?.sentence).toContain("merged reverted");
    expect(item?.options.map((o) => o.id)).toEqual(["ok", "restore"]);
    // No option of it can be taken in a batch.
    expect(item?.options.every((o) => o.effect === undefined)).toBe(true);
  });

  it("says nothing on thin evidence: 19 judged actions never demote", async () => {
    const d = desk({ authority: { merge: "decide" } });
    await fill(d, 0, 19);
    expect(d.authority.merge).toBe("decide");
  });

  it("does not demote again on the same old evidence, and 'Give it back' restores the row with a clean record", async () => {
    const d = desk({ authority: { merge: "decide" } });
    await fill(d, 10, 10);
    expect(d.authority.merge).toBe("ask");
    await d.svc.sweep();
    await d.svc.sweep();
    expect(d.authorityCalls).toHaveLength(1);
    expect(d.svc.decisions()).toHaveLength(1);
    const id = d.svc.repo.openNotices()[0]?.id ?? 0;
    await d.svc.answerNotice(id, "restore");
    expect(d.authority.merge).toBe("decide");
    expect(d.svc.decisions()).toEqual([]);
    // The old bad record is before the restore: it does not demote it a second time.
    d.clock.at = T0 + HOUR;
    await d.svc.sweep();
    expect(d.authority.merge).toBe("decide");
  });

  it("an Auto channel goes back to Draft and loses its Auto standing", async () => {
    const d = desk();
    d.gate.applyLadder("acme", "email", "auto");
    d.svc.repo.setTrust("acme", "outbound:email", { autoOk: true });
    for (let i = 0; i < 12; i++) d.draft(i, "email", "approved", T0 - 50 * HOUR + i * 60_000, "auto");
    for (let i = 12; i < 20; i++) d.draft(i, "email", "discarded", T0 - 50 * HOUR + i * 60_000, "auto");
    d.clock.at = T0 + 20 * HOUR;
    await d.svc.sweep();
    // Auto-sent drafts are judged by time: 12 kept, 8 rejected.
    expect(d.gate.mode("acme", "email")).toBe("draft");
    expect(d.svc.autoAccepted("acme", "email")).toBe(false);
    expect(d.svc.decisions()[0]?.title).toContain("Email went back to Draft");
  });
});

describe("the trust ladder: promotion", () => {
  /** A row on You with 20 recommendations the owner accepted. */
  function recommended(d: Desk, n: number, againstAt: number[] = []) {
    for (let i = 0; i < n; i++) {
      d.clock.at = T0 - 40 * 24 * HOUR + i * HOUR;
      d.svc.answered(
        {
          id: `room:ACM-${i}:a`,
          kind: "ship",
          org: "acme",
          task: `ACM-${i}`,
          suggestion: { option: "merge", reason: "ok", by: "captain" },
        },
        againstAt.includes(i) ? "changes" : "merge",
      );
    }
    d.clock.at = T0;
  }

  it("only proposes, never changes the row, and changes it when the owner accepts", async () => {
    const d = desk();
    recommended(d, 20);
    await d.svc.sweep();
    expect(d.authority.merge).toBe("ask");
    expect(d.authorityCalls).toEqual([]);
    const [item] = d.svc.decisions();
    expect(item?.title).toBe("Acme: Merge has run clean, 20 of 20 kept. Let the captain decide it?");
    expect(item?.options.map((o) => o.id)).toEqual(["promote", "later"]);
    // Many sweeps later it is still only a proposal.
    for (let i = 0; i < 3; i++) await d.svc.sweep();
    expect(d.authority.merge).toBe("ask");
    expect(d.svc.decisions()).toHaveLength(1);
    await d.svc.answerNotice(d.svc.repo.openNotices()[0]?.id ?? 0, "promote");
    expect(d.authority.merge).toBe("decide");
  });

  it("does not propose with a single miss, or while the owner overruled something this week", async () => {
    const miss = desk();
    recommended(miss, 20, [3]);
    await miss.svc.sweep();
    expect(miss.svc.decisions()).toEqual([]);

    const recent = desk();
    recommended(recent, 19);
    // The 20th is today and against the captain: not clean, and recent.
    recent.svc.answered(
      {
        id: "room:ACM-99:a",
        kind: "ship",
        org: "acme",
        task: "ACM-99",
        suggestion: { option: "merge", reason: "ok", by: "captain" },
      },
      "changes",
    );
    await recent.svc.sweep();
    expect(recent.svc.decisions()).toEqual([]);
  });

  it("holds a clean record back for a week after the owner took something back, with N = 5", async () => {
    const d = desk({ window: 5 });
    // Five accepted recommendations a month ago, then a plain miss two days ago, then five more clean ones.
    for (let i = 0; i < 5; i++) {
      d.clock.at = T0 - 30 * 24 * HOUR + i * HOUR;
      d.svc.answered(
        {
          id: `room:A-${i}:a`,
          kind: "ship",
          org: "acme",
          suggestion: { option: "merge", reason: "ok", by: "captain" },
        },
        "merge",
      );
    }
    d.clock.at = T0 - 2 * 24 * HOUR;
    d.svc.answered(
      {
        id: "room:B-1:a",
        kind: "ship",
        org: "acme",
        suggestion: { option: "merge", reason: "ok", by: "captain" },
      },
      "changes",
    );
    for (let i = 0; i < 5; i++) {
      d.clock.at = T0 - 2 * 24 * HOUR + (i + 1) * HOUR;
      d.svc.answered(
        {
          id: `room:C-${i}:a`,
          kind: "ship",
          org: "acme",
          suggestion: { option: "merge", reason: "ok", by: "captain" },
        },
        "merge",
      );
    }
    d.clock.at = T0;
    await d.svc.sweep();
    expect(d.svc.decisions()).toEqual([]);
    // Eight days after the miss, the same record qualifies.
    d.clock.at = T0 + 6 * 24 * HOUR;
    await d.svc.sweep();
    expect(d.svc.decisions()).toHaveLength(1);
  });

  it("does not repeat a promotion the owner put off, until the snooze ends", async () => {
    const d = desk();
    recommended(d, 20);
    await d.svc.sweep();
    await d.svc.answerNotice(d.svc.repo.openNotices()[0]?.id ?? 0, "later");
    expect(d.svc.decisions()).toEqual([]);
    for (let day = 1; day <= 13; day++) {
      d.clock.at = T0 + day * 24 * HOUR;
      await d.svc.sweep();
      expect(d.svc.decisions()).toEqual([]);
    }
    d.clock.at = T0 + 15 * 24 * HOUR;
    await d.svc.sweep();
    expect(d.svc.decisions()).toHaveLength(1);
    expect(d.authority.merge).toBe("ask");
  });

  it("withdraws an open proposal when the record turns", async () => {
    const d = desk({ window: 5 });
    for (let i = 0; i < 5; i++) {
      d.clock.at = T0 - 20 * 24 * HOUR + i * HOUR;
      d.svc.answered(
        {
          id: `room:A-${i}:a`,
          kind: "ship",
          org: "acme",
          suggestion: { option: "merge", reason: "ok", by: "captain" },
        },
        "merge",
      );
    }
    d.clock.at = T0;
    await d.svc.sweep();
    expect(d.svc.decisions()).toHaveLength(1);
    d.svc.answered(
      {
        id: "room:Z:a",
        kind: "ship",
        org: "acme",
        suggestion: { option: "merge", reason: "ok", by: "captain" },
      },
      "changes",
    );
    await d.svc.sweep();
    expect(d.svc.decisions()).toEqual([]);
  });

  it("makes Auto selectable for a channel only through an accepted promotion", async () => {
    const d = desk({ window: 5 });
    d.gate.applyLadder("acme", "email", "batch");
    for (let i = 0; i < 5; i++) d.draft(i, "email", "approved", T0 - 30 * 24 * HOUR + i * HOUR, "batch");
    await d.svc.sweep();
    const [item] = d.svc.decisions();
    expect(item?.title).toContain("Email drafts went out as written, 5 of 5. Move Email to Auto?");
    expect(() => d.gate.setMode({ org: "acme", channel: "email", mode: "auto", explicit: true })).toThrow(
      /Accept that proposal/,
    );
    await d.svc.answerNotice(d.svc.repo.openNotices()[0]?.id ?? 0, "promote");
    expect(d.gate.mode("acme", "email")).toBe("auto");
    expect(d.svc.autoAccepted("acme", "email")).toBe(true);
    // Another channel and another workspace have no standing.
    expect(d.svc.autoAccepted("acme", "post")).toBe(false);
    expect(d.svc.autoAccepted("globex", "email")).toBe(false);
  });
});

describe("auto-mute", () => {
  it("mutes a playbook whose findings are mostly dismissed to weekly, and one click undoes it", async () => {
    const d = desk({ window: 10 });
    for (let i = 0; i < 10; i++)
      d.finding(i, "deps", i < 2 ? "task" : "dismissed", T0 - 10 * HOUR + i * 60_000);
    await d.svc.sweep();
    expect(d.cadence.value).toEqual({ kind: "weekly", day: 1, at: "08:00" });
    const [item] = d.svc.decisions();
    expect(item?.title).toBe(
      "Acme: Dependency check now runs weekly. 8 of its last 10 findings were dismissed.",
    );
    expect(item?.options.map((o) => o.id)).toEqual(["undo", "ok"]);
    await d.svc.answerNotice(d.svc.repo.openNotices()[0]?.id ?? 0, "undo");
    expect(d.cadence.value).toEqual({ kind: "daily", at: "00:00" });
    expect(d.svc.decisions()).toEqual([]);
    // It does not mute again on the same old findings.
    await d.svc.sweep();
    expect(d.cadenceCalls).toHaveLength(2);
    expect(d.cadence.value.kind).toBe("daily");
  });

  it("leaves 70 percent alone (the rule is more than 70) and a playbook that is off or already weekly", async () => {
    // 7 of 10 is 70 percent exactly: not more.
    const exact = desk({ window: 10 });
    for (let i = 0; i < 10; i++) exact.finding(i, "deps", i < 3 ? "task" : "dismissed", T0 - HOUR + i);
    await exact.svc.sweep();
    expect(exact.cadence.value.kind).toBe("daily");
    const over = desk({ window: 10 });
    for (let i = 0; i < 10; i++) over.finding(i, "deps", i < 2 ? "task" : "dismissed", T0 - HOUR + i);
    await over.svc.sweep();
    expect(over.cadence.value.kind).toBe("weekly");
    const off = desk({ window: 10 });
    off.cadence.enabled = false;
    for (let i = 0; i < 10; i++) off.finding(i, "deps", "dismissed", T0 - HOUR + i);
    await off.svc.sweep();
    expect(off.cadenceCalls).toEqual([]);
  });

  it("never counts majhi's own folds as dismissals, and lifts a mute they caused by itself", async () => {
    const d = desk({ window: 10 });
    for (let i = 0; i < 10; i++) d.finding(i, "deps", "dismissed", T0 - HOUR + i);
    await d.svc.sweep();
    expect(d.cadence.value.kind).toBe("weekly");
    // The dismissals turn out to be folds into a grouped finding, as migrations 136 and 137 made them.
    d.db
      .prepare(
        "UPDATE findings SET dismissed_reason = 'Folded into one finding per project' WHERE playbook = 'deps'",
      )
      .run();
    await d.svc.sweep();
    expect(d.cadence.value).toEqual({ kind: "daily", at: "00:00" });
    expect(d.svc.decisions()).toEqual([]);
    // Folded findings alone never mute.
    const fresh = desk({ window: 10 });
    for (let i = 0; i < 10; i++) fresh.finding(i, "deps", "dismissed", T0 - HOUR + i);
    fresh.db
      .prepare(
        "UPDATE findings SET dismissed_reason = 'Folded into one finding per project' WHERE playbook = 'deps'",
      )
      .run();
    await fresh.svc.sweep();
    expect(fresh.cadenceCalls).toEqual([]);
  });

  it("can be undone from the command too, and only while muted", async () => {
    const d = desk({ window: 10 });
    for (let i = 0; i < 10; i++) d.finding(i, "deps", "dismissed", T0 - HOUR + i);
    await d.svc.sweep();
    await d.svc.unmute("acme", "deps");
    expect(d.cadence.value.kind).toBe("daily");
    await expect(d.svc.unmute("acme", "deps")).rejects.toThrow(/not muted/);
  });
});

describe("one monthly ceiling", () => {
  it("holds new starts once spend reaches it, never a turn already running, and asks as a Money decision", async () => {
    const d = desk();
    await d.svc.setMoney({ ceilingUsd: 100 });
    d.turn(T0 - 3 * 24 * HOUR, 60);
    expect(d.svc.ceilingHeld()).toBeUndefined();
    // A running turn adds its cost: the ceiling is crossed mid-turn.
    d.clock.at = T0 + 5_000;
    d.turn(T0 + 4_000, 45);
    expect(d.svc.ceilingHeld()).toBeUndefined(); // read a moment ago: the gate caches for a few seconds
    d.clock.at = T0 + 60_000;
    expect(d.svc.ceilingHeld()).toMatch(/monthly ceiling of \$100 is reached/);
    const [ask] = d.svc.decisions();
    expect(ask).toMatchObject({ id: "ceiling:2026-10", kind: "budget" });
    expect(ask?.options.map((o) => o.id)).toEqual(["raise", "leave"]);
    expect(ask?.options.every((o) => o.effect === undefined)).toBe(true);
    // Raising is for this month only and lifts the hold.
    await d.svc.answerCeiling("2026-10", "raise");
    expect(d.svc.ceilingHeld()).toBeUndefined();
    expect((await d.svc.money()).savedCeilingUsd).toBe(100);
    expect((await d.svc.money()).ceilingUsd).toBe(130);
  });

  it("keeps holding after 'Keep the ceiling' and asks nothing more that month", async () => {
    const d = desk();
    await d.svc.setMoney({ ceilingUsd: 50 });
    d.turn(T0 - HOUR, 80);
    d.clock.at = T0 + 60_000;
    expect(d.svc.ceilingHeld()).toBeDefined();
    await d.svc.answerCeiling("2026-10", "leave");
    expect(d.svc.ceilingHeld()).toBeDefined();
    expect(d.svc.decisions()).toEqual([]);
    await expect(d.svc.answerCeiling("2026-09", "raise")).rejects.toThrow(/month ended/);
  });

  it("rolls over at the owner's midnight, not UTC's", async () => {
    const d = desk();
    d.tz.value = "Pacific/Auckland";
    await d.svc.setMoney({ ceilingUsd: 100 });
    // 12:30 UTC on 30 Sep is 01:30 on 1 Oct in Auckland: October's spend.
    d.turn(Date.parse("2026-09-30T12:30:00.000Z"), 120);
    d.clock.at = Date.parse("2026-09-30T13:00:00.000Z");
    const october = await d.svc.money();
    expect(october.month).toBe("2026-10");
    expect(october.spentUsd).toBe(120);
    expect(d.svc.ceilingHeld()).toBeDefined();
    // The same instant in UTC is still September.
    d.tz.value = "UTC";
    d.clock.at += 30 * 60_000;
    expect((await d.svc.money()).month).toBe("2026-09");
    // A month later the spend is last month's and nothing is held.
    d.tz.value = "Pacific/Auckland";
    d.clock.at = Date.parse("2026-10-31T12:00:00.000Z");
    const november = await d.svc.money();
    expect(november.month).toBe("2026-11");
    expect(november.spentUsd).toBe(0);
    expect(d.svc.ceilingHeld()).toBeUndefined();
    expect(d.svc.decisions()).toEqual([]);
  });

  it("projects the month from the pace, and says nothing in the first day", async () => {
    const d = desk();
    d.clock.at = Date.parse("2026-10-11T00:00:00.000Z");
    d.turn(Date.parse("2026-10-05T00:00:00.000Z"), 100);
    await d.svc.setMoney({ ceilingUsd: 500 });
    const m = await d.svc.money();
    // 100 dollars in 10 days of a 31 day month.
    expect(m.projectedUsd).toBe(310);
    expect(m.line).toBe("$100 of $500 this month, on pace for $310");
    d.clock.at = Date.parse("2026-10-01T06:00:00.000Z");
    expect((await d.svc.money()).projectedUsd).toBeUndefined();
  });

  it("shows only spend where no rate is set, and never invents one", async () => {
    const d = desk();
    d.turn(T0 - HOUR, 12.5);
    d.action(1, T0 - 10 * HOUR);
    await d.svc.sweep();
    const m = await d.svc.money();
    const acme = m.orgs.find((o) => o.org === "acme");
    expect(acme).toMatchObject({ spentUsd: 12.5, rates: {} });
    expect(acme?.savedUsd).toBeUndefined();
    expect(acme?.marginUsd).toBeUndefined();
    expect(m.ceilingUsd).toBeUndefined();
    expect(m.held).toBe(false);
    // With rates: value of the time saved, and the retainer less the spend.
    const rated = await d.svc.setMoney({ rates: { org: "acme", retainerUsd: 2000, hourlyUsd: 90 } });
    const r = rated.orgs.find((o) => o.org === "acme");
    expect(r?.marginUsd).toBe(1987.5);
    expect(r?.savedUsd).toBe(7.5);
    // Clearing a rate takes it back out.
    const cleared = await d.svc.setMoney({ rates: { org: "acme", retainerUsd: null, hourlyUsd: null } });
    expect(cleared.orgs.find((o) => o.org === "acme")?.rates).toEqual({});
  });

  it("months have the right edges", () => {
    const w = monthWindow(new Date("2026-02-15T10:00:00.000Z"), "UTC");
    expect(w).toMatchObject({
      month: "2026-02",
      daysInMonth: 28,
      from: "2026-02-01T00:00:00.000Z",
      to: "2026-03-01T00:00:00.000Z",
    });
    expect(monthWindow(new Date("2026-12-31T23:59:00.000Z"), "UTC").to).toBe("2027-01-01T00:00:00.000Z");
  });
});
