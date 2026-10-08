import { ALL_ASK, type Authority, type AuthorityRow, type Cadence } from "@majhi/shared";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CaptainRepo } from "../captain/repo.ts";
import { OutboundGate } from "../playbooks/outbound.ts";
import { Store } from "../store/index.ts";
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
  it("drops a line to You and tells the owner when the owner undoes an action the captain took on it", async () => {
    const clean = desk({ authority: { merge: "decide" } });
    await fill(clean, 20, 0);
    expect(clean.authority.merge).toBe("decide");
    expect(clean.svc.decisions()).toEqual([]);

    const undone = desk({ authority: { merge: "decide" } });
    await fill(undone, 19, 1);
    expect(undone.authority.merge).toBe("ask");
    expect(undone.authorityCalls).toHaveLength(1);
    const [item] = undone.svc.decisions();
    expect(item).toMatchObject({ kind: "trust", org: "acme" });
    expect(item?.title).toContain("Merge is back to You in");
    expect(item?.title).toContain('you reverted "Shipped ACM-');
    expect(item?.options.map((o) => o.id)).toEqual(["ok", "restore"]);
    // No option of it can be taken in a batch.
    expect(item?.options.every((o) => o.effect === undefined)).toBe(true);
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

  it("makes Auto selectable for a channel only through an accepted promotion", async () => {
    const d = desk({ window: 5 });
    d.gate.applyLadder("acme", "email", "batch");
    for (let i = 0; i < 5; i++) d.draft(i, "email", "approved", T0 - 30 * 24 * HOUR + i * HOUR, "batch");
    await d.svc.sweep();
    const [_item] = d.svc.decisions();
    expect(() => d.gate.setMode({ org: "acme", channel: "email", mode: "auto", explicit: true })).toThrow(
      /./,
    );
    await d.svc.answerNotice(d.svc.repo.openNotices()[0]?.id ?? 0, "promote");
    expect(d.gate.mode("acme", "email")).toBe("auto");
    expect(d.svc.autoAccepted("acme", "email")).toBe(true);
    // Another channel and another workspace have no standing.
    expect(d.svc.autoAccepted("acme", "post")).toBe(false);
    expect(d.svc.autoAccepted("globex", "email")).toBe(false);
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
    expect(d.svc.ceilingHeld()).toBeDefined();
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
    await expect(d.svc.answerCeiling("2026-09", "raise")).rejects.toThrow(/./);
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
});
