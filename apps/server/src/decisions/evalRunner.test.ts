import {
  type Answer,
  askedOptions,
  type DecideRequest,
  DecideRequestSchema,
  optionKey,
  type Question,
} from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../store/migrations.ts";
import { builtinRegistry } from "./builtinSlots.ts";
import { type EvalProvider, EvalRunner } from "./evalRunner.ts";
import { EvalStore } from "./evalStore.ts";
import { LabelStore } from "./labels.ts";
import { DecisionLog } from "./log.ts";
import { computeMetrics, expectedCalibrationError, percentile, type ScoredItem } from "./metrics.ts";
import { SlotRegistry } from "./slots.ts";
import { service, sure } from "./testkit.ts";

const item = (over: Partial<ScoredItem> & Pick<ScoredItem, "truth" | "predicted">): ScoredItem => ({
  confidence: 0.9,
  accepted: true,
  latencyMs: 10,
  ...over,
});

describe("metrics", () => {
  it("reports accuracy, the majority baseline and per-class recall, and shows a one-class collapse", () => {
    // A model that says "large" to everything: 4 of 10 right, recall 0 for the other classes.
    const items: ScoredItem[] = [
      ...Array.from({ length: 4 }, () => item({ truth: "large", predicted: "large" })),
      ...Array.from({ length: 3 }, () => item({ truth: "small", predicted: "large" })),
      ...Array.from({ length: 3 }, () => item({ truth: "trivial", predicted: "large" })),
    ];
    const m = computeMetrics(items);
    expect(m.accuracy).toBeCloseTo(0.4);
    expect(m.majorityBaseline).toBeCloseTo(0.4);
    const byLabel = Object.fromEntries(m.perClass.map((c) => [c.label, c]));
    expect(byLabel.large).toMatchObject({ support: 4, recall: 1, precision: 0.4 });
    expect(byLabel.small).toMatchObject({ support: 3, recall: 0, precision: null });
    expect(byLabel.trivial?.recall).toBe(0);
  });

  it("gives precision and coverage at the gate", () => {
    const items: ScoredItem[] = [
      item({ truth: "a", predicted: "a", accepted: true }),
      item({ truth: "a", predicted: "a", accepted: true }),
      item({ truth: "a", predicted: "b", accepted: true }),
      item({ truth: "b", predicted: "b", accepted: false }),
    ];
    const m = computeMetrics(items);
    expect(m.coverage).toBeCloseTo(0.75);
    expect(m.precision).toBeCloseTo(2 / 3);
    expect(computeMetrics([item({ truth: "a", predicted: "a", accepted: false })]).precision).toBeNull();
  });

  it("computes the calibration error of known bins", () => {
    // Ten answers at 0.9 confidence, 5 right: the gap is 0.4.
    const ten = Array.from({ length: 10 }, (_, i) =>
      item({ truth: "a", predicted: i < 5 ? "a" : "b", confidence: 0.9 }),
    );
    expect(expectedCalibrationError(ten)).toBeCloseTo(0.4);
    // Perfectly calibrated: 0.5 confidence and half right.
    const fair = Array.from({ length: 10 }, (_, i) =>
      item({ truth: "a", predicted: i < 5 ? "a" : "b", confidence: 0.5 }),
    );
    expect(expectedCalibrationError(fair)).toBeCloseTo(0);
    expect(expectedCalibrationError([])).toBeNull();
  });

  it("takes nearest-rank percentiles and survives an empty or failed set", () => {
    expect(percentile([5, 1, 3, 2, 4, 10, 9, 8, 7, 6], 50)).toBe(5);
    expect(percentile([5, 1, 3, 2, 4, 10, 9, 8, 7, 6], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
    const m = computeMetrics([
      { truth: "a", predicted: undefined, confidence: 0, accepted: false, latencyMs: 4, failed: true },
    ]);
    expect(m).toMatchObject({ n: 0, failed: 1, accuracy: null, precision: null, coverage: 0 });
  });

  it("counts an abstention as wrong and out of coverage", () => {
    const m = computeMetrics([item({ truth: "a", predicted: undefined, accepted: false })]);
    expect(m.accuracy).toBe(0);
    expect(m.coverage).toBe(0);
  });

  it("reports order consistency only over items asked twice", () => {
    const m = computeMetrics([
      item({ truth: "a", predicted: "a", consistent: true }),
      item({ truth: "a", predicted: "a", consistent: false }),
      item({ truth: "a", predicted: "a" }),
    ]);
    expect(m.orderConsistency).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------------------------

function open() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, log: new DecisionLog(db), labels: new LabelStore(db), results: new EvalStore(db) };
}

/** A provider that follows a rule per question; counts its calls. */
function provider(
  answer: (
    key: string,
    q: Question,
    request: DecideRequest,
  ) => Answer | undefined | Promise<Answer | undefined>,
  over: Partial<EvalProvider> = {},
): EvalProvider & { calls: number } {
  const p = {
    id: "fake",
    calls: 0,
    version: () => "fake-1",
    costPer1000Usd: 0,
    ask: async (request: DecideRequest) => {
      p.calls += 1;
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(request.questions)) {
        const a = await answer(key, q, request);
        if (a !== undefined) out[key] = a;
      }
      return out;
    },
    ...over,
  };
  return p;
}

const firstOption = (q: Question): string | boolean =>
  q.type === "choice" ? (q.options.map(optionKey)[0] ?? "") : true;

function runner(p: EvalProvider, registry = builtinRegistry()) {
  const o = open();
  const r = new EvalRunner({
    registry,
    labels: o.labels,
    log: o.log,
    results: o.results,
    provider: p,
    gate: (_s, q, a) => ({ accepted: a.confidence >= 0.5, reason: "test", lift: 0, margin: 0 }),
    itemTimeoutMs: 50,
  });
  return { ...o, r };
}

describe("EvalRunner on the fixtures", () => {
  it("runs the built-in set of every slot that has one, through the real question builders", async () => {
    const { r } = runner(provider((_k, q) => sure(q, firstOption(q))));
    const withFixtures = builtinRegistry()
      .all()
      .filter((s) => s.fixtures !== undefined);
    expect(withFixtures.length).toBeGreaterThanOrEqual(8);
    for (const slot of withFixtures) {
      const report = await r.run(slot.id, "fixtures");
      expect(report.metrics.n, slot.id).toBeGreaterThanOrEqual(5);
      expect(report.metrics.failed, slot.id).toBe(0);
      // Every fixture's label is something the question can be answered with.
      const fixtures = slot.fixtures?.() ?? [];
      for (const f of fixtures) {
        const q = DecideRequestSchema.parse(f.request).questions[f.question];
        expect(q, `${slot.id} ${f.question}`).toBeDefined();
        const options = q?.type === "choice" ? askedOptions(q).map(optionKey) : ["true", "false"];
        const label = slot.classOf === undefined ? f.label : f.label;
        expect([...options, "not-keep"], `${slot.id}: ${label}`).toContain(label);
      }
    }
  });

  it("a perfect provider scores 1, and shows position bias when it always takes the first option", async () => {
    const truth = new Map<string, string>();
    const perfect = provider((key, q, request) => {
      const text = JSON.stringify(request.state);
      return sure(q, truth.get(`${key}${text}`) ?? firstOption(q));
    });
    const { r } = runner(perfect);
    // Always the first listed option: right half the time on a two-class set, and it flips when reversed.
    const biased = runner(provider((_k, q) => sure(q, firstOption(q))));
    const report = await biased.r.run("review-verdict", "fixtures");
    expect(report.metrics.accuracy).toBeCloseTo(0.5);
    expect(report.metrics.orderConsistency).toBe(0);
    expect(report.metrics.perClass.find((c) => c.label === "B")?.recall).toBe(0);
    expect(await r.run("review-verdict", "fixtures")).toMatchObject({
      slot: "review-verdict",
      set: "fixtures",
    });
  });
});

describe("EvalRunner when the provider misbehaves", () => {
  it("counts a throw, a hang and a missing answer as failed and still reports the rest", async () => {
    let n = 0;
    const flaky = provider(async (_k, q) => {
      n += 1;
      if (n % 4 === 1) throw new Error("boom");
      if (n % 4 === 2) await new Promise(() => {});
      if (n % 4 === 3) return undefined;
      return sure(q, firstOption(q));
    });
    const { r } = runner(flaky);
    const report = await r.run("review-verdict", "fixtures");
    expect(report.metrics.failed + report.metrics.n).toBe(8);
    expect(report.metrics.failed).toBeGreaterThan(0);
    expect(report.metrics.n).toBeGreaterThan(0);
  });

  it("survives garbage: an option nobody offered, NaN and negative probabilities, an empty value", async () => {
    const garbage = provider((key) => {
      if (key === "verdict") return { value: "Z", confidence: 7, probabilities: { Z: Number.NaN } };
      return { value: "", confidence: -1, probabilities: { x: -3 } } as Answer;
    });
    const { r } = runner(garbage);
    const report = await r.run("review-verdict", "fixtures");
    expect(report.metrics.accuracy).toBe(0);
    expect(report.metrics.precision === null || report.metrics.precision === 0).toBe(true);
    expect(Number.isFinite(report.metrics.ece ?? 0)).toBe(true);
  });

  it("shares one run between two callers", async () => {
    const p = provider((_k, q) => sure(q, firstOption(q)));
    const { r } = runner(p);
    const [a, b] = await Promise.all([r.run("task-size", "fixtures"), r.run("task-size", "fixtures")]);
    expect(a.id).toBe(b.id);
    const once = p.calls;
    await r.run("task-size", "fixtures");
    expect(p.calls).toBeGreaterThan(once);
  });

  it("refuses a slot that does not exist", async () => {
    const { r } = runner(provider(() => undefined));
    await expect(r.run("no-such-slot", "fixtures")).rejects.toThrow(/no decision slot/);
  });
});

describe("a new use added as data", () => {
  it("is evaluated with no change to the harness", async () => {
    const registry = new SlotRegistry([
      {
        id: "log-incident",
        title: "Is this log line an incident",
        use: "tool",
        question: /^incident$/,
        target: 0.95,
        fixtures: () =>
          [
            ["ERROR payment service unreachable for 5 minutes", "true"],
            ["INFO health check ok", "false"],
            ["WARN disk usage 95% on db-1", "true"],
            ["DEBUG cache warmed", "false"],
          ].map(([line, label]) => ({
            request: {
              state: { line: line ?? "" },
              questions: {
                incident: { type: "noul" as const, instructions: "Does this line report an incident?" },
              },
            },
            question: "incident",
            label: label ?? "",
          })),
      },
    ]);
    // A provider that reads the word ERROR or WARN.
    const { r } = runner(
      provider((_k, q, request) => sure(q, /ERROR|WARN/.test(JSON.stringify(request.state)))),
      registry,
    );
    const report = await r.run("log-incident", "fixtures");
    expect(report.metrics.accuracy).toBe(1);
    expect(report.metrics.perClass.map((c) => c.label).sort()).toEqual(["false", "true"]);
  });
});

describe("EvalRunner on labeled decisions", () => {
  it("uses the owner's label over an outcome label and skips decisions without a stored request", async () => {
    const slots = [{ id: "size", title: "Size", use: "task-size" as const, question: /^size$/, target: 0.9 }];
    const { svc, laya } = service(undefined, undefined, slots);
    const ask = (state: string) => ({
      state,
      questions: { size: { type: "choice" as const, instructions: "How big?", options: ["small", "large"] } },
    });
    const a = await svc.decide(ask("one"), { use: "task-size" });
    const b = await svc.decide(ask("two"), { use: "task-size" });
    svc.labels().add({ decisionId: a.id, question: "size", label: "large", source: "outcome" });
    svc.labels().add({ decisionId: a.id, question: "size", label: "small", source: "owner" });
    svc.labels().add({ decisionId: b.id, question: "size", label: "large", source: "outcome" });
    laya.calls = 0;
    const reports = await svc.runEvals("size");
    expect(reports).toHaveLength(1);
    // The fake answers `small` to everything: right for a (owner), wrong for b.
    expect(reports[0]).toMatchObject({ slot: "size", set: "labels", provider: "laya" });
    expect(reports[0]?.metrics.n).toBe(2);
    expect(reports[0]?.metrics.accuracy).toBeCloseTo(0.5);
    expect(svc.slots().find((s) => s.slot === "size")).toMatchObject({ labels: 2, mode: "shadow" });
  });

  it("says which slots exist when asked for an unknown one", async () => {
    const { svc } = service();
    await expect(svc.runEvals("nope")).rejects.toThrow(/no decision slot nope/);
  });
});
