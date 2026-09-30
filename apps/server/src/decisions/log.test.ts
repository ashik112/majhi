import { DecideRequestSchema, type DecisionRecord } from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../store/migrations.ts";
import { DecisionLog } from "./log.ts";

const KEY = "AKIAIOSFODNN7EXAMPLE";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function open() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, log: new DecisionLog(db) };
}

const request = DecideRequestSchema.parse({
  state: { task: "Rotate the keys", description: `The old key ${KEY} leaked` },
  questions: {
    size: { type: "choice", instructions: `How much work? Token ${TOKEN}`, options: ["small", "large"] },
  },
});

function record(id: string, at: string, over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id,
    at,
    use: "model-pick",
    summary: `size: How much work? Token ${TOKEN}`,
    provider: "laya",
    answers: {
      size: {
        value: "large",
        confidence: 0.6,
        probabilities: { small: 0.3, large: 0.6, none: 0.1 },
        gate: { accepted: true, reason: "0.40 over chance, 0.30 ahead", lift: 0.4, margin: 0.3 },
      },
    },
    estimated: false,
    durationMs: 12,
    request: {
      state: request.state,
      questions: request.questions,
      sent: { size: { type: "choice", instructions: "How much work?", criteria: { small: "", large: KEY } } },
    },
    trimmed: false,
    skipped: [{ provider: "jev", reason: "No Jev key is set" }],
    version: "laya-mlx 0.2.0",
    ...over,
  };
}

describe("DecisionLog", () => {
  it("never writes a detected secret: state, questions, what was sent, summary and outcome", () => {
    const { db, log } = open();
    log.add(
      record("dec_1", "2026-09-30T10:00:00.000Z", { outcome: { text: `used ${KEY}`, fellBack: false } }),
    );
    const raw = JSON.stringify(db.prepare("SELECT * FROM decisions").all());
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(TOKEN);
    const [back] = log.recent(1);
    expect(back?.request?.state).toEqual({
      task: "Rotate the keys",
      description: "The old key [redacted] leaked",
    });
    expect(back?.summary).toBe("size: How much work? Token [redacted]");
    expect(back?.outcome?.text).toBe("used [redacted]");
    // Everything else comes back as it went in.
    expect(back).toMatchObject({
      answers: { size: { value: "large", gate: { accepted: true } } },
      trimmed: false,
      skipped: [{ provider: "jev" }],
      version: "laya-mlx 0.2.0",
    });
  });

  it("keeps the outcome and the owner's correction, and reads rows written before them", () => {
    const { db, log } = open();
    db.prepare(
      "INSERT INTO decisions (id, at, use, summary, provider, answers, estimated, duration_ms) VALUES ('dec_old', '2026-09-01T00:00:00.000Z', 'routing', 's', 'rules', '{}', 0, 1)",
    ).run();
    log.add(record("dec_2", "2026-09-30T10:00:00.000Z"));
    expect(
      log.setOutcome("dec_2", {
        text: "large: most capable",
        fellBack: false,
        choices: ["model tier: balanced"],
      }),
    ).toBe(true);
    expect(log.correct("dec_2", { right: "model tier: balanced", at: "2026-09-30T11:00:00.000Z" })).toBe(
      true,
    );
    expect(log.correct("dec_none", { right: "x", at: "2026-09-30T11:00:00.000Z" })).toBe(false);
    expect(log.get("dec_2")).toMatchObject({
      outcome: { fellBack: false },
      correction: { right: "model tier: balanced" },
    });
    expect(log.get("dec_old")).toMatchObject({ id: "dec_old", provider: "rules" });
  });

  it("pages newest first", () => {
    const { log } = open();
    for (let i = 0; i < 25; i++)
      log.add(record(`dec_${i}`, `2026-09-30T10:${String(i).padStart(2, "0")}:00.000Z`));
    expect(log.recent(10).map((r) => r.id)[0]).toBe("dec_24");
    expect(log.recent(10, 20).map((r) => r.id)).toEqual(["dec_4", "dec_3", "dec_2", "dec_1", "dec_0"]);
  });
});
