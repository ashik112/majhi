import type { Actor } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../memory/db.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { MemoryService } from "../memory/service.ts";
import { MemoryStore } from "../memory/store.ts";
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
