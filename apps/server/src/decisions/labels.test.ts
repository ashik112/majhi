import { describe, expect, it } from "vitest";
import { service } from "./testkit.ts";

const ask = {
  state: { task: "Fix a typo", kind: "code" },
  questions: {
    difficulty: { type: "choice" as const, instructions: "How big?", options: ["trivial", "large"] },
  },
};

describe("labels", () => {
  it("keeps one label per decision, question and source, and the newest wins", async () => {
    const { svc } = service();
    const r = await svc.decide(ask, { use: "task-size" });
    const labels = svc.labels();
    expect(labels.add({ decisionId: r.id, question: "difficulty", label: "small", source: "outcome" })).toBe(
      true,
    );
    labels.add({ decisionId: r.id, question: "difficulty", label: "medium", source: "outcome" });
    labels.add({ decisionId: r.id, question: "difficulty", label: "large", source: "owner" });
    expect(
      labels
        .forDecision(r.id)
        .map((l) => [l.source, l.label])
        .sort(),
    ).toEqual([
      ["outcome", "medium"],
      ["owner", "large"],
    ]);
  });

  it("hides secrets in the note, and refuses a label for an unknown decision", async () => {
    const { svc, db } = service();
    const labels = svc.labels();
    expect(labels.add({ decisionId: "dec_none", question: "q", label: "x", source: "owner" })).toBe(false);
    const r = await svc.decide(ask, { use: "task-size" });
    labels.add({
      decisionId: r.id,
      question: "difficulty",
      label: "small",
      source: "owner",
      note: "key AKIAIOSFODNN7EXAMPLE leaked",
    });
    const raw = db.prepare("SELECT note FROM decision_labels").get() as { note: string };
    expect(raw.note).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
