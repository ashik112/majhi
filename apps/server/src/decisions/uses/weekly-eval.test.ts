import {
  type Answer,
  type DecideRequest,
  DecideRequestSchema,
  type EvalMetrics,
  type EvalReport,
  FindingReportInputSchema,
  type SlotStatus,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { FindingsRepo } from "../../findings/repo.ts";
import { FindingsService } from "../../findings/service.ts";
import { UPKEEP_PLAYBOOKS } from "../../playbooks/builtin/upkeep.ts";
import { Store } from "../../store/index.ts";
import { fakeLaya, type LayaScript, service, sure } from "../testkit.ts";
import { LAYA_USE_SLOTS } from "./slots.ts";
import { layaEvalRunner, regressionOf } from "./weekly-eval.ts";

/** The weekly eval job: it runs the harness, and files a finding for each slot that got worse. */

const metrics = (over: Partial<EvalMetrics> = {}): EvalMetrics => ({
  n: 40,
  failed: 0,
  accuracy: 0.9,
  majorityBaseline: 0.5,
  perClass: [],
  precision: 0.92,
  coverage: 0.7,
  ece: 0.05,
  orderConsistency: 1,
  latencyP50Ms: 200,
  latencyP90Ms: 600,
  costPer1000Usd: 0,
  ...over,
});

const report = (
  at: string,
  over: Partial<EvalMetrics>,
  set: "labels" | "fixtures" = "labels",
): EvalReport => ({
  id: 1,
  slot: "s",
  title: "S",
  set,
  at,
  provider: "laya",
  version: "0.2.0",
  metrics: metrics(over),
});

describe("regressionOf", () => {
  const slot = { target: 0.9 };

  it("says nothing for a steady slot, and keeps the run before for the Hub", () => {
    const got = regressionOf(slot, true, [
      report("2026-10-11T03:00:00Z", { precision: 0.92 }),
      report("2026-10-04T03:00:00Z", { precision: 0.93 }),
    ]);
    expect(got.regressed).toBeUndefined();
    expect(got.previous).toMatchObject({ at: "2026-10-04T03:00:00Z", precision: 0.93 });
  });

  it("flags a drop of five points on labels, and not four", () => {
    const worse = (to: number) =>
      regressionOf(slot, false, [
        report("2026-10-11T03:00:00Z", { precision: to }),
        report("2026-10-04T03:00:00Z", { precision: 0.95 }),
      ]).regressed;
    expect(worse(0.9)).toMatch(/fell from 95% to 90% since 2026-10-04/);
    expect(worse(0.91)).toBeUndefined();
  });

  it("allows more room on the few built-in examples", () => {
    const run = (to: number) =>
      regressionOf(slot, false, [
        report("2026-10-11T03:00:00Z", { precision: null, accuracy: to }, "fixtures"),
        report("2026-10-04T03:00:00Z", { precision: null, accuracy: 0.9 }, "fixtures"),
      ]).regressed;
    expect(run(0.78)).toBeDefined();
    expect(run(0.85)).toBeUndefined();
  });

  it("flags a live slot under its target even with no run before", () => {
    expect(regressionOf(slot, true, [report("2026-10-11T03:00:00Z", { precision: 0.85 })]).regressed).toMatch(
      /live at 85%, under its target of 90%/,
    );
    // A slot in shadow acts on nothing: being under its target is not a regression.
    expect(
      regressionOf(slot, false, [report("2026-10-11T03:00:00Z", { precision: 0.85 })]).regressed,
    ).toBeUndefined();
  });

  it("ignores a run where Laya answered too little to say anything", () => {
    expect(
      regressionOf(slot, true, [
        report("2026-10-11T03:00:00Z", { n: 0, failed: 40, precision: null, accuracy: null }),
        report("2026-10-04T03:00:00Z", { precision: 0.95 }),
      ]),
    ).toEqual({});
    expect(
      regressionOf(slot, true, [
        report("2026-10-11T03:00:00Z", { precision: 0.5 }),
        report("2026-10-04T03:00:00Z", { n: 3, precision: 1 }),
      ]).regressed,
    ).toMatch(/under its target/);
  });

  it("falls back to accuracy when nothing cleared the gate", () => {
    const got = regressionOf(slot, false, [
      report("2026-10-11T03:00:00Z", { precision: null, accuracy: 0.7 }),
      report("2026-10-04T03:00:00Z", { precision: null, accuracy: 0.9 }),
    ]);
    expect(got.regressed).toMatch(/fell from 90% to 70%/);
  });
});

/** A Laya that knows the right label of every built-in example, and can be told to get them wrong. */
function oracle() {
  const labels = new Map<string, string>();
  for (const slot of LAYA_USE_SLOTS) {
    for (const f of slot.fixtures?.() ?? []) {
      labels.set(`${f.question}\u0000${JSON.stringify(DecideRequestSchema.parse(f.request).state)}`, f.label);
    }
  }
  const mode = { wrong: false, down: false };
  const script: LayaScript = async (request: DecideRequest) => {
    if (mode.down) throw new Error("Laya is down");
    const out: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(request.questions)) {
      const right = labels.get(`${key}\u0000${JSON.stringify(request.state)}`);
      if (q.type === "choice") {
        const options = q.options.map((o) => (typeof o === "string" ? o : o.key));
        const pick = right ?? options[0] ?? "";
        out[key] = sure(q, mode.wrong ? (options.find((o) => o !== pick) ?? pick) : pick, 0.95);
      } else if (q.type === "noul") {
        const pick = right === "true";
        out[key] = sure(q, mode.wrong ? !pick : pick, 0.95);
      } else out[key] = sure(q, q.min, 0.9);
    }
    return out;
  };
  return { script, mode };
}

function setup() {
  const o = oracle();
  const { svc } = service(fakeLaya({ script: o.script }), undefined, LAYA_USE_SLOTS);
  const findings = new FindingsService({
    repo: new FindingsRepo(new Store(":memory:").raw),
    projectOrg: async () => "private",
    taskStatus: () => undefined,
    createTask: async () => ({ id: "ACM-1" }),
  });
  const playbook = UPKEEP_PLAYBOOKS.find((p) => p.id === "upkeep-laya-eval");
  if (playbook === undefined) throw new Error("the Laya check playbook is missing");
  const runner = layaEvalRunner({ decisions: svc });
  const run = () =>
    runner.run({
      org: "private",
      playbook,
      settings: {},
      findings,
      now: () => new Date("2026-10-11T03:00:00Z"),
      fetch,
    });
  const open = () => findings.list({ org: "private", limit: 100 }, { kind: "owner" }).findings;
  return { ...o, svc, findings, run, open };
}

describe("the weekly eval job", () => {
  it("is an Upkeep playbook of the rules kind that runs once for the business, weekly", () => {
    const p = UPKEEP_PLAYBOOKS.find((x) => x.id === "upkeep-laya-eval");
    expect(p).toMatchObject({
      pack: "upkeep",
      scope: "business",
      runner: { kind: "rules", id: "laya-eval" },
      cost: { tier: "rules", tokens: 0 },
      trigger: { cadence: { kind: "weekly" } },
    });
  });

  it("files nothing for a steady Laya, and shows each slot's accuracy on the Hub", async () => {
    const t = setup();
    const first = await t.run();
    expect(first.findings).toBe(0);
    const second = await t.run();
    expect(second.findings).toBe(0);
    const slots = t.svc.slots().filter((s) => LAYA_USE_SLOTS.some((l) => l.id === s.slot));
    expect(slots).toHaveLength(LAYA_USE_SLOTS.length);
    for (const s of slots) {
      expect(s.fixtures?.metrics.accuracy, s.slot).toBe(1);
      expect(s.previous, s.slot).toBeDefined();
      expect(s.regressed, s.slot).toBeUndefined();
    }
    expect(t.open()).toEqual([]);
  });

  it("files a finding for each slot that got worse, once, and closes it when the slot recovers", async () => {
    const t = setup();
    await t.run();
    t.mode.wrong = true;
    const worse = await t.run();
    expect(worse.findings).toBe(LAYA_USE_SLOTS.length);
    const filed = t.open();
    expect(filed.map((f) => f.dedupeKey).toSorted()).toEqual(
      LAYA_USE_SLOTS.map((s) => `laya-regression:${s.id}`).toSorted(),
    );
    expect(filed.every((f) => f.source === "setup" && f.playbook === "upkeep-laya-eval")).toBe(true);
    expect(filed[0]?.title).toMatch(/^Laya got worse at: /);
    // The same week again refreshes them, it does not file twice.
    await t.run();
    expect(t.open()).toHaveLength(LAYA_USE_SLOTS.length);
    expect(t.svc.slots().find((s) => s.slot === "wake-gate")?.regressed).toBeDefined();
    // Laya recovers: the findings close.
    t.mode.wrong = false;
    await t.run();
    await t.run();
    expect(t.open().filter((f) => f.status === "open")).toEqual([]);
  });

  it("files nothing when Laya is down: a run where it answered nothing says nothing", async () => {
    const t = setup();
    await t.run();
    t.mode.down = true;
    const note = await t.run();
    expect(note.findings).toBe(0);
    expect(t.open()).toEqual([]);
  });

  it("fails the run, so the playbook backs off, when the harness itself cannot run", async () => {
    const runner = layaEvalRunner({
      decisions: {
        slots: () => [] as SlotStatus[],
        runEvals: async () => {
          throw new Error("the database is locked");
        },
      },
    });
    const playbook = UPKEEP_PLAYBOOKS.find((p) => p.id === "upkeep-laya-eval");
    if (playbook === undefined) throw new Error("missing");
    const findings = new FindingsService({
      repo: new FindingsRepo(new Store(":memory:").raw),
      projectOrg: async () => "private",
      taskStatus: () => undefined,
      createTask: async () => ({ id: "ACM-1" }),
    });
    await expect(
      runner.run({ org: "private", playbook, settings: {}, findings, now: () => new Date(), fetch }),
    ).rejects.toThrow(/the evals did not run: the database is locked/);
  });

  it("also reads a few findings filed before triage existed, and says how many", async () => {
    const t = setup();
    const backlog = { triageBacklog: async (limit: number) => Math.min(limit, 7) };
    const withBacklog = layaEvalRunner({ decisions: t.svc, backlog });
    const playbook = UPKEEP_PLAYBOOKS.find((p) => p.id === "upkeep-laya-eval");
    if (playbook === undefined) throw new Error("missing");
    const got = await withBacklog.run({
      org: "private",
      playbook,
      settings: {},
      findings: t.findings,
      now: () => new Date(),
      fetch,
    });
    expect(got.note).toMatch(/7 old findings read/);
    // A backlog that fails does not fail the job.
    const failing = layaEvalRunner({
      decisions: t.svc,
      backlog: {
        triageBacklog: async () => {
          throw new Error("boom");
        },
      },
    });
    await expect(
      failing.run({
        org: "private",
        playbook,
        settings: {},
        findings: t.findings,
        now: () => new Date(),
        fetch,
      }),
    ).resolves.toBeDefined();
    void FindingReportInputSchema;
  });
});
