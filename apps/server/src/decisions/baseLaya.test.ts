import {
  type Answer,
  askedOptions,
  type DecideRequest,
  DecisionSettingsSchema,
  optionKey,
  type Question,
} from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../store/migrations.ts";
import { BUILTIN_SLOTS, builtinRegistry } from "./builtinSlots.ts";
import { previewGate } from "./calibration.ts";
import { type EvalProvider, EvalRunner } from "./evalRunner.ts";
import { EvalStore } from "./evalStore.ts";
import { LabelStore } from "./labels.ts";
import { DecisionLog } from "./log.ts";
import { sure } from "./testkit.ts";

/**
 * A stand-in for the base Laya checkpoint, shaped like what the audit measured on majhi's own
 * decisions (2026-10-04): about 0.36 accuracy on typed decisions, which is below the majority
 * baseline; one class chosen far too often ("large" for task size, "keep" for memory, "true"
 * for yes/no); confidence that does not track being right (ECE about 0.2); and a third of choices
 * changing when the options are turned around.
 */
function baseLaya(slotTruth: Map<string, string>, seed = 11): EvalProvider {
  const rnd = (text: string) => {
    let h = seed;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 2654435761) >>> 0;
    return () => {
      h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      return h / 2 ** 32;
    };
  };
  const FAVOURITE = ["large", "keep", "true", "A", "medium"];
  return {
    id: "laya",
    version: () => "laya-mlx 0.2.0",
    costPer1000Usd: 0,
    ask: async (request: DecideRequest) => {
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(request.questions)) {
        const keys =
          q.type === "choice"
            ? askedOptions(q)
                .map(optionKey)
                .filter((k) => k !== "none")
            : ["true", "false"];
        const state = JSON.stringify(request.state);
        const truth = slotTruth.get(`${key}\u0000${state}`);
        const r = rnd(`${key}${state}${q.type === "choice" ? JSON.stringify(q.options) : ""}`);
        const sticky = keys.find((k) => FAVOURITE.includes(k)) ?? keys[0] ?? "";
        let value = r() < 0.36 && truth !== undefined && keys.includes(truth) ? truth : sticky;
        // A third of the time the answer is whatever the option order made likely.
        if (r() < 0.33) value = keys[Math.floor(r() * keys.length)] ?? value;
        const p = 0.55 + 0.4 * r();
        out[key] = sureFor(q, value, p);
      }
      return out;
    },
  };
}

function sureFor(q: Question, value: string, p: number): Answer {
  return sure(q, q.type === "noul" ? value === "true" : value, p, 2);
}

describe("base Laya as the audit measured it, on the built-in fixtures", () => {
  it("shows low accuracy, one-class collapse, over-confidence and order flips, and no slot goes live", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const registry = builtinRegistry();
    const truth = new Map<string, string>();
    for (const slot of BUILTIN_SLOTS)
      for (const f of slot.fixtures?.() ?? [])
        truth.set(`${f.question}\u0000${JSON.stringify((f.request as { state: unknown }).state)}`, f.label);
    const settings = DecisionSettingsSchema.parse({});
    const runner = new EvalRunner({
      registry,
      labels: new LabelStore(db),
      log: new DecisionLog(db),
      results: new EvalStore(db),
      provider: baseLaya(truth),
      gate: (_s, q, a, cal) => previewGate(q, a, cal, settings),
    });
    const rows: string[] = [];
    let total = 0;
    let correct = 0;
    for (const slot of registry.all().filter((s) => s.fixtures !== undefined)) {
      const r = await runner.run(slot.id, "fixtures");
      const m = r.metrics;
      total += m.n;
      correct += (m.accuracy ?? 0) * m.n;
      const recalls = m.perClass
        .map((c) => `${c.label}:${c.recall === null ? "-" : c.recall.toFixed(2)}`)
        .join(" ");
      rows.push(
        `${slot.id.padEnd(18)} n=${String(m.n).padStart(2)} acc=${(m.accuracy ?? 0).toFixed(2)} base=${(m.majorityBaseline ?? 0).toFixed(2)} ` +
          `prec@gate=${m.precision === null ? " - " : m.precision.toFixed(2)} cov=${m.coverage.toFixed(2)} ece=${(m.ece ?? 0).toFixed(2)} ` +
          `orders=${m.orderConsistency === null ? " - " : m.orderConsistency.toFixed(2)} recall[${recalls}]`,
      );
      // The point of the harness: none of this earns trust.
      expect(m.failed).toBe(0);
      expect(m.accuracy ?? 0).toBeLessThan(0.8);
    }
    console.info(
      `\n${rows.join("\n")}\noverall accuracy ${(correct / total).toFixed(2)} over ${total} fixtures\n`,
    );
    expect(correct / total).toBeLessThan(0.6);
  });
});
