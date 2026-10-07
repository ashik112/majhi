import type { RoomItem, TaskStatus } from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Subject } from "../notify/attention.ts";
import { migrate } from "../store/migrations.ts";
import { buildDecisions, type DecisionSources } from "./build.ts";
import { RecommendationRepo } from "./recommendations.ts";
import { type DecisionActions, InboxService } from "./service.ts";

type Of<T extends RoomItem["type"]> = Extract<RoomItem, { type: T }>;
const base = (id: string, task: string, at = "2026-10-04T09:00:00.000Z") => ({ id, task, seq: 1, at });

const review = (task: string): Of<"review"> => ({
  ...base(`rv-${task}`, task),
  type: "review",
  lead: "acme-builder",
  state: "pending",
});
const paused = (task: string): Of<"paused"> => ({
  ...base(`pa-${task}`, task),
  type: "paused",
  reason: "blocked",
  state: "pending",
});
const approval = (task: string, command: string, at = "2026-10-04T09:00:00.000Z"): Of<"approval"> => ({
  ...base(`ap-${task}`, task, at),
  type: "approval",
  agent: "acme-builder",
  command,
  risk: "change",
  summary: "Merge the task into its base",
  input: "{}",
  state: "pending",
});
const permission = (task: string): Of<"permission"> => ({
  ...base(`pm-${task}`, task),
  type: "permission",
  agent: "acme-builder",
  title: "Run npm test",
  options: [
    { id: "no", name: "Reject", kind: "reject_once" },
    { id: "always", name: "Always allow", kind: "allow_always" },
    { id: "yes", name: "Allow", kind: "allow_once" },
  ],
  state: "pending",
});
const ask = (task: string): Of<"ask"> => ({
  ...base(`ask-${task}`, task),
  type: "ask",
  agent: "acme-builder",
  questions: [
    {
      id: "q",
      question: "Keep it?",
      options: [{ id: "keep", label: "Keep" }],
      freeText: false,
    },
  ],
  state: "pending",
});

function subject(id: string, status: TaskStatus, extra: Partial<Subject> = {}): Subject {
  return { id, title: `Task ${id}`, chat: false, org: "acme", repos: 1, status, ...extra };
}

function build(items: RoomItem[], subjects: Subject[], over: Partial<DecisionSources> = {}) {
  const by = new Map(subjects.map((s) => [s.id, s]));
  return buildDecisions({
    items,
    subject: (task) => by.get(task),
    budgets: [],
    signedOut: [],
    recommendations: new Map(),
    ...over,
  });
}

describe("cards derive from the task's state now, so none goes stale", () => {
  it("a review card of a task that is no longer in review is no decision", () => {
    for (const status of ["running", "paused", "mr", "inbox", "ready"] as const) {
      expect(build([review("ACM-1")], [subject("ACM-1", status)])).toEqual([]);
    }
    expect(build([review("ACM-1")], [subject("ACM-1", "review")])).toHaveLength(1);
  });

  it("a merge approval or permission of a paused task is no decision", () => {
    const items = [approval("ACM-1", "tasks.merge"), permission("ACM-1")];
    expect(build(items, [subject("ACM-1", "paused")])).toEqual([]);
    expect(build(items, [subject("ACM-1", "running")])).toHaveLength(2);
  });

  it("a parent that waits on its subtasks has no pause card", () => {
    expect(build([paused("ACM-1")], [subject("ACM-1", "paused", { openSubtasks: 2 })])).toEqual([]);
    expect(build([paused("ACM-1")], [subject("ACM-1", "paused", { openSubtasks: 0 })])).toHaveLength(1);
    // A pause card of a task that runs again is gone too.
    expect(build([paused("ACM-1")], [subject("ACM-1", "running")])).toEqual([]);
  });

  it("a split approval disappears once its subtasks exist, but a later one stays", () => {
    const split = approval("ACM-1", "tasks.split", "2026-10-04T09:00:00.000Z");
    const early = subject("ACM-1", "running", { openSubtasks: 3, newestSubtask: "2026-10-04T09:00:05.000Z" });
    expect(build([split], [early])).toEqual([]);
    const old = subject("ACM-1", "running", { openSubtasks: 3, newestSubtask: "2026-10-04T08:00:00.000Z" });
    expect(build([split], [old])).toHaveLength(1);
  });

  it("a review whose merge fails says why and offers no Merge", () => {
    const blocked = new Map([["ACM-1", { why: "Nothing to merge: no commits ahead of main.", empty: true }]]);
    const [card] = build([review("ACM-1")], [subject("ACM-1", "review")], { shipBlocked: blocked });
    expect(card?.options.map((o) => o.id)).toEqual(["done", "changes"]);
    expect(card?.options.some((o) => o.effect === "approve")).toBe(false);
    // A conflict leaves only a word to the lead.
    const failing = new Map([["ACM-1", { why: "it conflicts with main in a.ts", empty: false }]]);
    const [second] = build([review("ACM-1")], [subject("ACM-1", "review")], { shipBlocked: failing });
    expect(second?.options.map((o) => o.id)).toEqual(["changes"]);
  });
});

const noActions = {} as unknown as DecisionActions;

function inbox(opts: {
  items: RoomItem[];
  subjects: Subject[];
  working: string[];
  block?: (task: string) => Promise<{ why: string; empty: boolean } | undefined>;
  now?: () => Date;
  changed?: () => void;
}) {
  const by = new Map(opts.subjects.map((s) => [s.id, s]));
  const db = new Database(":memory:");
  migrate(db);
  return new InboxService({
    items: () => opts.items,
    subject: (task) => by.get(task),
    budgets: async () => [],
    signedOut: async () => [{ id: "claude-acme", at: "2026-10-04T06:00:00.000Z" }],
    recommendations: new RecommendationRepo(db),
    actions: noActions,
    working: () => opts.working,
    ...(opts.block === undefined ? {} : { shipBlock: opts.block }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.changed === undefined ? {} : { changed: opts.changed }),
  });
}

describe("one count for every screen", () => {
  const subjects = [
    subject("ACM-1", "running"), // an agent works
    subject("ACM-2", "running"), // an agent waits on a question
    subject("ACM-3", "paused", { openSubtasks: 2 }), // a parent waiting on its subtasks
    subject("ACM-4", "review"), // finished, merge fails
    subject("ACM-5", "mr"), // merge request open
    subject("GLX-1", "running", { org: "globex" }), // working in another workspace
    subject("PRV-1", "running", { org: undefined }), // a task of none, working
    { ...subject("CHAT-1", "running"), chat: true }, // a chat does not count as a task
  ];
  const items = [ask("ACM-2"), paused("ACM-3"), review("ACM-4"), review("ACM-5"), permission("GLX-1")];
  const working = ["ACM-1", "ACM-2", "ACM-3", "GLX-1", "PRV-1", "CHAT-1"];

  it("counts the same decisions the list, the bell, the sidebar and the banner show", async () => {
    const { decisions, counts } = await inbox({
      items,
      subjects,
      working,
      block: async () => ({ why: "Nothing to merge: no commits ahead of main.", empty: true }),
    }).view();
    // The question, the failing review and the globex permission, plus the sign-in: not the stale
    // pause of the parent, nor the review of the task whose merge request is open.
    expect(decisions.map((d) => d.id).toSorted()).toEqual(
      ["room:ACM-2:ask-ACM-2", "room:ACM-4:rv-ACM-4", "room:GLX-1:pm-GLX-1", "signin:claude-acme"].toSorted(),
    );
    expect(counts.needsYou).toBe(decisions.length);
    expect(counts.orgs.acme?.needsYou).toBe(2);
    expect(counts.orgs.globex?.needsYou).toBe(1);
    // Working is the tasks an agent works on and nobody waits on: ACM-1 and PRV-1 only. ACM-2 asks,
    // GLX-1 asks, ACM-3 is paused, the chat is no task.
    expect(counts.workingTasks.toSorted()).toEqual(["ACM-1", "PRV-1"]);
    expect(counts.working).toBe(2);
    expect(counts.orgs.acme?.working).toBe(1);
    expect(counts.orgs.private).toEqual({ needsYou: 0, working: 1 });
    // The workspace's own list and its count agree.
    const acme = await inbox({ items, subjects, working }).view("acme");
    expect(acme.decisions.length).toBe(acme.counts.orgs.acme?.needsYou);
  });

  it("keeps the card when the look at the merge breaks", async () => {
    const service = inbox({
      items: [review("ACM-4")],
      subjects: [subject("ACM-4", "review")],
      working: [],
      block: async () => {
        throw new Error("git is busy");
      },
    });
    const [card] = (await service.list()).filter((d) => d.kind === "ship");
    expect(card?.blocked).toBeUndefined();
    expect(card?.options.map((o) => o.id)).toContain("merge");
  });
});
