import type { Actor } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../memory/db.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { MemoryService } from "../memory/service.ts";
import { MemoryStore } from "../memory/store.ts";
import { sizeBucket } from "./labels.ts";
import { service } from "./testkit.ts";

const ask = {
  state: { task: "Fix a typo", kind: "code" },
  questions: {
    difficulty: { type: "choice" as const, instructions: "How big?", options: ["trivial", "large"] },
  },
};

describe("sizeBucket", () => {
  it("buckets by the diff", () => {
    expect(sizeBucket({ files: 1, lines: 4, turns: 2, outputTokens: 1000 }).label).toBe("trivial");
    expect(sizeBucket({ files: 2, lines: 41, turns: 3, outputTokens: 5000 }).label).toBe("small");
    expect(sizeBucket({ files: 7, lines: 300, turns: 10, outputTokens: 20_000 }).label).toBe("medium");
    expect(sizeBucket({ files: 30, lines: 2000, turns: 10, outputTokens: 20_000 }).label).toBe("large");
  });

  it("calls a one-line fix after a long hunt large", () => {
    expect(sizeBucket({ files: 1, lines: 2, turns: 60, outputTokens: 300_000 }).label).toBe("large");
  });

  it("handles an empty task", () => {
    expect(sizeBucket({ files: 0, lines: 0, turns: 0, outputTokens: 0 }).label).toBe("trivial");
  });
});

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

  it("refuses a label for a decision that is not in the log, and hides secrets in the note", async () => {
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

  it("labels the task-size decision when the task reaches review, and again at the next review", async () => {
    const { svc } = service();
    const rated = await svc.rateTask({
      task: "ACM-1",
      title: "Fix a typo",
      brief: "Fix a typo in the readme",
      kind: "code",
      repos: ["acme-web"],
      role: "Builder",
      use: "task-size",
    });
    expect(rated?.decisionId).toBeDefined();
    svc.taskReviewed("ACM-1", { files: 1, lines: 3, turns: 2, outputTokens: 900 });
    expect(svc.labels().forDecision(rated?.decisionId ?? "")[0]).toMatchObject({
      use: "task-size",
      question: "difficulty",
      label: "trivial",
      source: "outcome",
    });
    svc.taskReviewed("ACM-1", { files: 12, lines: 700, turns: 50, outputTokens: 90_000 });
    expect(svc.labels().forDecision(rated?.decisionId ?? "")).toHaveLength(1);
    expect(svc.labels().forDecision(rated?.decisionId ?? "")[0]?.label).toBe("large");
  });

  it("labels nothing for a task nobody rated, or another task's rating", async () => {
    const { svc, db } = service();
    await svc.rateTask({ task: "ACM-1", title: "t", brief: "b", kind: "code", repos: [], role: "Builder" });
    svc.taskReviewed("ACM-2", { files: 1, lines: 1, turns: 1, outputTokens: 1 });
    svc.resolve("wake", "nobody", "true");
    expect((db.prepare("SELECT COUNT(*) AS n FROM decision_labels").get() as { n: number }).n).toBe(0);
  });

  it("labels a linked decision once for a wake, then forgets the link", async () => {
    const { svc } = service();
    const r = await svc.decide(ask, { use: "routing", task: "ACM-1" });
    svc.link("wake", "ACM-1\u0000acme-builder", r.id, "difficulty");
    svc.resolve("wake", "ACM-1\u0000acme-builder", "true", "acted");
    svc.resolve("wake", "ACM-1\u0000acme-builder", "false", "second turn");
    const labels = svc.labels().forDecision(r.id);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ label: "true", note: "acted", use: "routing" });
  });

  it("two outcomes arriving together label each decision once", async () => {
    const { svc } = service();
    const a = await svc.decide(ask, { use: "routing" });
    const b = await svc.decide({ ...ask, state: "different" }, { use: "routing" });
    svc.link("tracker", "ACM-9", a.id, "difficulty");
    svc.link("tracker", "ACM-9", b.id, "difficulty");
    svc.resolve("tracker", "ACM-9", "acme-web");
    expect(svc.labels().counts()).toEqual([{ use: "routing", question: "difficulty", n: 2 }]);
  });
});

describe("the owner's choice on a memory fact", () => {
  const owner: Actor = { kind: "owner" };
  const agent: Actor = { kind: "agent", id: "acme-builder" };

  it("tells the listener when the owner approves or rejects, and not when an agent does", async () => {
    const memory = new MemoryService({
      store: new MemoryStore(openMemoryDb(":memory:")),
      embedder: new HashEmbedder(),
      embedWaitMs: 100,
    });
    const heard: string[] = [];
    memory.onOwnerChoice((id, action) => heard.push(`${id}:${action}`));
    const a = await memory.propose({
      text: "Use pnpm",
      scope: "global",
      task: "ACM-1",
      agent: "acme-builder",
    });
    const b = await memory.propose({
      text: "Use yarn",
      scope: "global",
      task: "ACM-1",
      agent: "acme-builder",
    });
    memory.reject(b.id, agent);
    expect(heard).toEqual([]);
    memory.approve(a.id, owner);
    expect(heard).toEqual([`${a.id}:approved`]);
  });
});
