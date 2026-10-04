import { batchSummary, type RoomItem } from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../store/migrations.ts";
import { taskWorld } from "../testing/world.ts";
import { RecommendationRepo } from "./recommendations.ts";
import { type DecisionActions, InboxService } from "./service.ts";

/**
 * Batch approve and leave in the owner's inbox: each decision is taken on its own, a double send does
 * nothing the second time, and a request the captain recommends rejecting is never approved in bulk.
 */

type Permission = Extract<RoomItem, { type: "permission" }>;
type Review = Extract<RoomItem, { type: "review" }>;

const permission = (n: number, task = "ACM-1", title = `Run pnpm test ${n}`): Permission => ({
  id: `pm${n}`,
  task,
  seq: n,
  at: `2026-10-04T09:${String(n % 60).padStart(2, "0")}:00.000Z`,
  type: "permission",
  agent: "acme-builder",
  title,
  options: [
    { id: "no", name: "Reject", kind: "reject_once" },
    { id: "yes", name: "Allow once", kind: "allow_once" },
    { id: "always", name: "Always allow", kind: "allow_always" },
  ],
  state: "pending",
});

const review = (n: number, ready: boolean): Review => ({
  id: `rv${n}`,
  task: "ACM-2",
  seq: n,
  at: "2026-10-04T10:00:00.000Z",
  type: "review",
  lead: "acme-builder",
  ...(ready ? { ready: "Ready to ship to main: committed, merges cleanly into main." } : {}),
  state: "pending",
});

const subjects = {
  "ACM-1": { id: "ACM-1", title: "Fix the API", chat: false, org: "acme", repos: 1 },
  "ACM-2": { id: "ACM-2", title: "Docs", chat: false, org: "acme", repos: 1 },
};

function setup(items: RoomItem[], options: { failOn?: ReadonlySet<string> } = {}) {
  const db = new Database(":memory:");
  migrate(db);
  const repo = new RecommendationRepo(db);
  const log: string[] = [];
  const pending = new Set(items.map((i) => `${i.task}:${i.id}`));
  const actions: DecisionActions = {
    answerAsk: async () => {},
    answerQuestion: async () => {},
    answerChoice: async () => {},
    answerPermission: (task, item, option) => {
      if (options.failOn?.has(item)) throw new Error(`${item} is not waiting for an answer any more`);
      pending.delete(`${task}:${item}`);
      log.push(`permission ${item} ${option}`);
    },
    decideApproval: async () => {},
    cardAction: async (task, item, action) => {
      pending.delete(`${task}:${item}`);
      log.push(`card ${item} ${action}`);
      return {};
    },
    askChanges: async () => {},
    answerBudget: async () => {},
    decideDraft: async () => {},
    decideBatch: async () => {},
  };
  const inbox = new InboxService({
    items: () => items.filter((i) => pending.has(`${i.task}:${i.id}`)),
    subject: (task) => subjects[task as keyof typeof subjects],
    budgets: async () => [],
    signedOut: async () => [],
    recommendations: repo,
    actions,
    now: () => new Date("2026-10-04T12:00:00.000Z"),
  });
  return { inbox, repo, log, pending };
}

describe("batch approve and leave", () => {
  it("takes 200 decisions where some fail midway: the rest go on and the result lists the failures", async () => {
    const items = Array.from({ length: 200 }, (_, i) => permission(i + 1));
    const bad = new Set(["pm50", "pm51", "pm120"]);
    const { inbox, log } = setup(items, { failOn: bad });
    const ids = items.map((i) => `room:${i.task}:${i.id}`);

    const out = await inbox.answerBatch({ batch: "batch-0001", intent: "approve", ids });

    expect(out.done).toHaveLength(197);
    expect(out.failed.map((f) => f.id)).toEqual(["room:ACM-1:pm50", "room:ACM-1:pm51", "room:ACM-1:pm120"]);
    expect(out.failed[0]?.error).toContain("not waiting");
    expect(out.skipped).toEqual([]);
    // Allow once, never the remembered "Always allow".
    expect(new Set(log.map((l) => l.split(" ")[2]))).toEqual(new Set(["yes"]));
    // What still waits is exactly the three that failed.
    expect(out.decisions.map((d) => d.id).sort()).toEqual(out.failed.map((f) => f.id).sort());
  });

  it("is idempotent when the same click is sent twice, even at the same moment", async () => {
    const items = Array.from({ length: 30 }, (_, i) => permission(i + 1));
    const { inbox, log } = setup(items);
    const input = {
      batch: "batch-0002",
      intent: "approve" as const,
      ids: items.map((i) => `room:${i.task}:${i.id}`),
    };

    const [first, second] = await Promise.all([inbox.answerBatch(input), inbox.answerBatch(input)]);
    const third = await inbox.answerBatch(input);

    expect(log).toHaveLength(30);
    expect(second).toBe(first);
    expect(third).toEqual(first);
  });

  it("a second click with a new key finds them gone and answers nothing twice", async () => {
    const items = [permission(1), permission(2)];
    const { inbox, log } = setup(items);
    const ids = items.map((i) => `room:${i.task}:${i.id}`);
    await inbox.answerBatch({ batch: "batch-0003", intent: "approve", ids });
    const again = await inbox.answerBatch({ batch: "batch-0004", intent: "approve", ids });
    expect(log).toHaveLength(2);
    expect(again.done).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual([
      "It was answered already",
      "It was answered already",
    ]);
  });

  it("leaves what has no button for the intent, and merges only what the captain checked", async () => {
    const items = [permission(1), review(1, true), review(2, false)];
    const { inbox, log } = setup(items);
    const out = await inbox.answerBatch({
      batch: "batch-0005",
      intent: "approve",
      ids: ["room:ACM-1:pm1", "room:ACM-2:rv1", "room:ACM-2:rv2"],
    });
    expect(out.done).toEqual(["room:ACM-1:pm1", "room:ACM-2:rv1"]);
    expect(out.skipped).toEqual([{ id: "room:ACM-2:rv2", reason: "It has no button to approve in bulk" }]);
    expect(log).toEqual(["permission pm1 yes", "card rv1 merge"]);
  });

  it("does not approve a request the captain recommends rejecting", async () => {
    const items = [permission(1), permission(2)];
    const { inbox, repo, log } = setup(items);
    repo.set(
      "room:ACM-1:pm1",
      { option: "no", reason: "it reads the whole home folder" },
      "2026-10-04T09:30:00.000Z",
    );
    const out = await inbox.answerBatch({
      batch: "batch-0006",
      intent: "approve",
      ids: ["room:ACM-1:pm1", "room:ACM-1:pm2"],
    });
    expect(out.done).toEqual(["room:ACM-1:pm2"]);
    expect(out.skipped).toEqual([{ id: "room:ACM-1:pm1", reason: "The captain suggests Deny" }]);
    expect(log).toEqual(["permission pm2 yes"]);
  });

  it("Leave rejects requests once, and says what it will do in one line", async () => {
    const items = [permission(1), permission(2), review(1, true)];
    const { inbox, log } = setup(items);
    const waiting = await inbox.list();
    expect(batchSummary(waiting, "approve")).toBe("Merge 1, allow once 2.");
    expect(batchSummary(waiting, "leave")).toBe("Reject 2. 1 will wait for you.");
    const out = await inbox.answerBatch({
      batch: "batch-0007",
      intent: "leave",
      ids: waiting.map((d) => d.id),
    });
    expect(log.sort()).toEqual(["permission pm1 no", "permission pm2 no"]);
    expect(out.skipped).toHaveLength(1);
  });
});

describe("decisions.answerBatch through the command table", () => {
  it("is the owner's: an agent, the captain included, is refused", async () => {
    const w = await taskWorld();
    try {
      const input = { batch: "batch-0008", intent: "approve" as const, ids: ["room:ACM-1:nothing"] };
      const agent = await w.h.cmd("decisions.answerBatch", input, {
        actor: { kind: "agent", id: "acme-builder" },
      });
      expect(agent.status).toBe(409);
      const owner = await w.h.cmd("decisions.answerBatch", input);
      expect(owner.status).toBe(200);
      expect(owner.body).toMatchObject({
        done: [],
        skipped: [{ id: "room:ACM-1:nothing", reason: "It was answered already" }],
      });
    } finally {
      await w.cleanup();
    }
  });
});
