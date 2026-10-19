import { ALL_ASK, type Authority, type Cadence } from "@majhi/shared";
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

let seq = 100;

/** Fills a row with judged ship actions: `kept` kept and the rest undone. */
async function _fill(d: Desk, kept: number, undone: number, from = T0 - 100 * HOUR) {
  for (let k = 0; k < kept + undone; k++) {
    const at = from + k * 60_000;
    const id = d.action(++seq, at);
    if (k >= kept) d.undo(id, at + 5 * 60_000);
  }
  d.clock.at = T0;
  await d.svc.sweep();
}

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
});
