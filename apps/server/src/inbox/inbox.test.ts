import type { BudgetAsk, CaptainCapAsk, CommandName, RoomItem } from "@majhi/shared";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../commands/handlers.ts";
import { migrate } from "../store/migrations.ts";
import { buildDecisions, type DecisionSources, isDecisionItem } from "./build.ts";
import { inboxHandlers } from "./handlers.ts";
import { RecommendationRepo } from "./recommendations.ts";
import { type DecisionActions, InboxService } from "./service.ts";

type Of<T extends RoomItem["type"]> = Extract<RoomItem, { type: T }>;

const base = (id: string, at: string, task = "ACM-1") => ({ id, task, seq: 1, at });

const ask: Of<"ask"> = {
  ...base("ask1", "2026-10-04T09:00:00.000Z"),
  type: "ask",
  agent: "acme-builder",
  questions: [
    {
      id: "q",
      question: "Rebuild or keep the history?",
      options: [
        { id: "keep", label: "Keep" },
        { id: "rebuild", label: "Rebuild" },
      ],
      default: "rebuild",
      freeText: false,
    },
  ],
  state: "pending",
};
const choice: Of<"choice"> = {
  ...base("ch1", "2026-10-04T09:01:00.000Z"),
  type: "choice",
  agent: "acme-builder",
  question: "Start now or wait?",
  options: [
    { id: "now", label: "Start now" },
    { id: "wait", label: "Wait" },
  ],
  state: "pending",
};
const ownerQuestion: Of<"owner-question"> = {
  ...base("oq1", "2026-10-04T09:02:00.000Z"),
  type: "owner-question",
  agent: "acme-builder",
  text: "Which queue?",
  choices: ["Redis", "SQS"],
  state: "pending",
};
const permission: Of<"permission"> = {
  ...base("pm1", "2026-10-04T09:03:00.000Z"),
  type: "permission",
  agent: "acme-builder",
  title: "Run npm test",
  options: [
    { id: "no", name: "Reject", kind: "reject_once" },
    { id: "yes", name: "Allow once", kind: "allow_once" },
  ],
  state: "pending",
};
const approval: Of<"approval"> = {
  ...base("ap1", "2026-10-04T09:04:00.000Z"),
  type: "approval",
  agent: "acme-builder",
  command: "orgs.create",
  risk: "change",
  summary: "Create org Globex",
  input: "{}",
  state: "pending",
};
const secret: Of<"secret-request"> = {
  ...base("sr1", "2026-10-04T09:05:00.000Z"),
  type: "secret-request",
  agent: "acme-builder",
  name: "stripe-acme",
  label: "Stripe test key",
  state: "pending",
};
const review: Of<"review"> = {
  ...base("rv1", "2026-10-04T10:00:00.000Z", "ACM-2"),
  type: "review",
  lead: "acme-builder",
  ready:
    "Ready to ship to main: committed, merges cleanly into main. Acme is set to Keeps things tidy, so the captain asks before shipping.",
  state: "pending",
};
const paused: Of<"paused"> = {
  ...base("pa1", "2026-10-04T08:00:00.000Z", "ACM-2"),
  type: "paused",
  reason: "limit",
  state: "pending",
};

const cap: CaptainCapAsk = {
  org: "acme",
  chore: "memory",
  day: "2026-10-04",
  kind: "actions",
  cap: 20,
  raiseTo: 40,
  text: "Acme: the memory chore reached its 20 actions for today. Raise it to 40?",
  at: "2026-10-04T07:00:00.000Z",
};
const budget: BudgetAsk = {
  scope: "acme",
  name: "Acme",
  day: "2026-10-04",
  cap: { cost: 20 },
  raiseTo: { cost: 40 },
  waiting: 3,
  text: "Acme used its $20 for today. 3 tasks are waiting. Raise it to $40 for today?",
  at: "2026-10-04T11:00:00.000Z",
};

const subjects: Record<string, { id: string; title: string; chat: boolean; org?: string; repos: number }> = {
  "ACM-1": { id: "ACM-1", title: "Fix the API", chat: false, org: "acme", repos: 1 },
  "ACM-2": { id: "ACM-2", title: "Docs", chat: false, org: "acme", repos: 1 },
};

function sources(over: Partial<DecisionSources> = {}): DecisionSources {
  return {
    items: [],
    subject: (task) => subjects[task],
    caps: [],
    budgets: [],
    signedOut: [],
    recommendations: new Map(),
    ...over,
  };
}

describe("building decisions", () => {
  it("maps each waiting item to a decision with the right options", () => {
    const out = buildDecisions(
      sources({
        items: [ask, choice, ownerQuestion, permission, approval, secret, review, paused],
        caps: [cap],
        budgets: [budget],
        signedOut: [{ id: "claude-acme", at: "2026-10-04T06:00:00.000Z" }],
      }),
    );
    const by = (id: string) => out.find((d) => d.id === id);
    expect(by("room:ACM-1:ask1")).toMatchObject({
      kind: "question",
      org: "acme",
      task: "ACM-1",
      link: { kind: "task", id: "ACM-1", item: "ask1" },
      // The default goes first and is the primary button.
      options: [
        { id: "rebuild", label: "Rebuild", primary: true },
        { id: "keep", label: "Keep" },
      ],
      suggestion: { option: "rebuild", by: "agent" },
    });
    expect(by("room:ACM-1:ch1")?.options.map((o) => o.id)).toEqual(["now", "wait"]);
    expect(by("room:ACM-1:oq1")).toMatchObject({
      kind: "question",
      title: "Which queue?",
      options: [
        { id: "c0", label: "Redis", primary: true },
        { id: "c1", label: "SQS" },
      ],
    });
    expect(by("room:ACM-1:pm1")).toMatchObject({
      kind: "approval",
      options: [
        { id: "yes", label: "Allow once", primary: true },
        { id: "no", label: "Reject" },
      ],
    });
    expect(by("room:ACM-1:ap1")?.options.map((o) => o.id)).toEqual(["approve", "reject"]);
    expect(by("room:ACM-1:sr1")).toMatchObject({ kind: "secret", options: [] });
    expect(by("room:ACM-2:rv1")).toMatchObject({
      kind: "ship",
      options: [
        { id: "merge", label: "Merge", primary: true },
        { id: "done", label: "Mark done" },
        { id: "changes", label: "Ask for changes", text: true },
      ],
      suggestion: { option: "merge", by: "captain" },
    });
    expect(by("room:ACM-2:pa1")).toMatchObject({
      kind: "paused",
      options: [{ id: "resume", label: "Resume", primary: true }],
    });
    expect(by("cap:acme:memory:2026-10-04")).toMatchObject({
      kind: "cap",
      org: "acme",
      options: [
        { id: "raise", label: "Raise to 40 for today", primary: true },
        { id: "leave", label: "Leave it" },
      ],
    });
    expect(by("budget:acme:2026-10-04")).toMatchObject({
      kind: "budget",
      org: "acme",
      options: [{ id: "raise", label: "Raise to $40 for today", primary: true }, { id: "leave" }],
      link: { kind: "limits" },
    });
    expect(by("signin:claude-acme")).toMatchObject({
      kind: "sign-in",
      options: [],
      link: { kind: "account" },
    });
  });

  it("puts ship and budget first, then the oldest", () => {
    const out = buildDecisions(
      sources({ items: [ask, choice, review, paused], budgets: [budget], caps: [cap] }),
    );
    expect(out.map((d) => d.id)).toEqual([
      "room:ACM-2:rv1",
      "budget:acme:2026-10-04",
      "cap:acme:memory:2026-10-04",
      "room:ACM-2:pa1",
      "room:ACM-1:ask1",
      "room:ACM-1:ch1",
    ]);
  });

  it("leaves out what waits for nobody: answered cards, an owner pause, a task that is gone", () => {
    const out = buildDecisions(
      sources({
        items: [
          { ...ask, state: "answered" },
          { ...paused, reason: "owner" },
          { ...choice, task: "ACM-9" },
          { ...review, ready: undefined },
        ],
      }),
    );
    expect(out.map((d) => d.id)).toEqual(["room:ACM-2:rv1"]);
    expect(out[0]).toMatchObject({
      title: "Ready for review: Docs",
      sentence: '@acme-builder finished "Docs" and waits for your review.',
      options: [
        { id: "merge", label: "Merge", primary: true },
        { id: "done", label: "Mark done" },
        { id: "changes", label: "Ask for changes", text: true },
      ],
    });
    expect(isDecisionItem({ ...paused, reason: "offline" }, subjects["ACM-2"] as never)).toBe(false);
  });

  it("offers the ask card's several questions only through the task", () => {
    const [first] = ask.questions;
    const two = { ...ask, questions: [first, { ...first, id: "q2" }] } as Of<"ask">;
    expect(buildDecisions(sources({ items: [two] }))[0]?.options).toEqual([]);
  });

  it("shows the captain's recommendation over the agent's, only for an option that exists", () => {
    const recommendations = new Map([
      ["room:ACM-1:ask1", { option: "keep", reason: "keeps a backup branch, nothing pushed" }],
      ["room:ACM-1:ch1", { option: "gone", reason: "stale" }],
    ]);
    const out = buildDecisions(sources({ items: [ask, choice], recommendations }));
    expect(out[0]?.suggestion).toEqual({
      option: "keep",
      reason: "keeps a backup branch, nothing pushed",
      by: "captain",
    });
    expect(out[0]?.options).toEqual([
      { id: "keep", label: "Keep", primary: true },
      { id: "rebuild", label: "Rebuild" },
    ]);
    expect(out[1]?.suggestion).toBeUndefined();
  });
});

function fakeActions(log: string[]): DecisionActions {
  return {
    answerAsk: async (t, i, a) => void log.push(`ask ${t} ${i} ${JSON.stringify(a)}`),
    answerQuestion: async (t, i, c) => void log.push(`question ${t} ${i} ${c}`),
    answerChoice: async (t, i, o) => void log.push(`choice ${t} ${i} ${o}`),
    answerPermission: (t, i, o) => void log.push(`permission ${t} ${i} ${o}`),
    decideApproval: async (t, i, d) => void log.push(`approval ${t} ${i} ${d}`),
    cardAction: async (t, i, a) => {
      log.push(`card ${t} ${i} ${a}`);
      return mergeResults === undefined ? {} : { results: mergeResults };
    },
    askChanges: async (t, text, lead) => void log.push(`changes ${t} ${lead ?? "-"} ${text}`),
    answerCap: async (o, c, a) => void log.push(`cap ${o} ${c} ${a}`),
    answerBudget: async (s, a) => void log.push(`budget ${s} ${a}`),
  };
}

let log: string[];
let mergeResults: { project: string; ok: boolean; detail: string }[] | undefined;
let repo: RecommendationRepo;
let items: RoomItem[];

function service(): InboxService {
  return new InboxService({
    items: () => items,
    subject: (task) => subjects[task],
    caps: async () => [cap],
    budgets: async () => [budget],
    signedOut: async () => [{ id: "claude-acme", at: "2026-10-04T06:00:00.000Z" }],
    recommendations: repo,
    actions: fakeActions(log),
    now: () => new Date("2026-10-04T12:00:00.000Z"),
  });
}

beforeEach(() => {
  log = [];
  mergeResults = undefined;
  const db = new Database(":memory:");
  migrate(db);
  repo = new RecommendationRepo(db);
  items = [ask, choice, ownerQuestion, permission, approval, secret, review, paused];
});

describe("answering a decision", () => {
  it.each([
    ["room:ACM-1:ask1", "keep", undefined, 'ask ACM-1 ask1 {"q":"keep"}'],
    ["room:ACM-1:ask1", "keep", "something else", 'ask ACM-1 ask1 {"q":"something else"}'],
    ["room:ACM-1:ch1", "wait", undefined, "choice ACM-1 ch1 wait"],
    ["room:ACM-1:oq1", "c1", undefined, "question ACM-1 oq1 SQS"],
    ["room:ACM-1:pm1", "yes", undefined, "permission ACM-1 pm1 yes"],
    ["room:ACM-1:ap1", "reject", undefined, "approval ACM-1 ap1 reject"],
    ["room:ACM-1:ap1", "approve", undefined, "approval ACM-1 ap1 approve"],
    ["room:ACM-2:rv1", "merge", undefined, "card ACM-2 rv1 merge"],
    ["room:ACM-2:rv1", "done", undefined, "card ACM-2 rv1 done"],
    [
      "room:ACM-2:rv1",
      "changes",
      "  Use the shared helper.  ",
      "changes ACM-2 acme-builder Use the shared helper.",
    ],
    ["room:ACM-2:pa1", "resume", undefined, "card ACM-2 pa1 resume"],
    ["cap:acme:memory:2026-10-04", "raise", undefined, "cap acme memory raise"],
    ["budget:acme:2026-10-04", "leave", undefined, "budget acme leave"],
  ])("routes %s / %s to its own path", async (id, option, text, expected) => {
    await service().answer({ id, option, ...(text === undefined ? {} : { text }) });
    expect(log).toEqual([expected]);
  });

  it("refuses Ask for changes without words and says why a merge that failed did not finish", async () => {
    const inbox = service();
    await expect(inbox.answer({ id: "room:ACM-2:rv1", option: "changes", text: "  " })).rejects.toThrow(
      /Write your answer/,
    );
    mergeResults = [{ project: "api", ok: false, detail: "conflicts in 2 files" }];
    await expect(inbox.answer({ id: "room:ACM-2:rv1", option: "merge" })).rejects.toThrow(
      /Could not merge api: conflicts in 2 files/,
    );
    expect(log).toEqual(["card ACM-2 rv1 merge"]);
  });

  it("offers a task with no repo Mark done first and no Merge", () => {
    const noRepo = { ...subjects["ACM-2"], repos: 0 } as never;
    const out = buildDecisions(sources({ items: [{ ...review, ready: undefined }], subject: () => noRepo }));
    expect(out[0]?.options.map((o) => o.id)).toEqual(["done", "changes"]);
    expect(out[0]?.options[0]?.primary).toBe(true);
  });

  it("refuses an option the decision does not offer, a secret and a sign-in, and does nothing", async () => {
    const inbox = service();
    await expect(inbox.answer({ id: "room:ACM-1:ch1", option: "maybe" })).rejects.toThrow(
      /not one of the options/,
    );
    await expect(inbox.answer({ id: "room:ACM-1:sr1", option: "save" })).rejects.toThrow();
    await expect(inbox.answer({ id: "signin:claude-acme", option: "x" })).rejects.toThrow();
    await expect(inbox.answer({ id: "room:ACM-1:nope", option: "x" })).rejects.toThrow(/gone/);
    expect(log).toEqual([]);
  });

  it("answers only for the owner: an agent, the captain too, is refused before anything runs", async () => {
    const handlers = inboxHandlers(service());
    const ctx = (kind: "owner" | "agent"): CommandContext => ({
      command: "decisions.answer" as CommandName,
      meta: { actor: kind === "owner" ? { kind: "owner" } : { kind: "agent", id: "majhi-boss" } },
    });
    const input = { id: "room:ACM-1:ch1", option: "now" };
    await expect(handlers["decisions.answer"](input, ctx("agent"))).rejects.toThrow(/owner's/);
    expect(log).toEqual([]);
    await handlers["decisions.answer"](input, ctx("owner"));
    expect(log).toEqual(["choice ACM-1 ch1 now"]);
  });
});

describe("the detail of a decision", () => {
  const diff = (project: string, files: [string, number, number][]) => ({
    project,
    base: "main",
    branch: "majhi/ACM-2",
    commits: [],
    files: files.map(([path, additions, deletions]) => ({
      path,
      status: "modified" as const,
      additions,
      deletions,
      binary: false,
      patch: "",
      truncated: false,
    })),
    omitted: 0,
    uncommitted: false,
  });
  const ok = { ok: true } as const;
  const withDetail = (over: Partial<ConstructorParameters<typeof InboxService>[0]> = {}) =>
    new InboxService({
      items: () => items,
      subject: (task) => subjects[task],
      caps: async () => [],
      budgets: async () => [],
      signedOut: async () => [],
      recommendations: repo,
      actions: fakeActions(log),
      orgNames: async () => ({ acme: "Acme" }),
      lastAgentMessage: () => ({
        agent: "acme-builder",
        text: "Done. Two files changed.",
        at: "2026-10-04T09:59:00.000Z",
      }),
      diff: async () => [
        diff("api", [
          ["src/a.ts", 3, 1],
          ["src/b.ts", 40, 2],
          ["README.md", 1, 0],
        ]),
      ],
      shipOptions: async () => ({ merge: ok, mergePush: ok, push: ok, mr: ok, done: ok }),
      ...over,
    });

  it("gives a ready-to-ship task its hand-back, diff stat, checks and target, with the old wording rewritten", async () => {
    const detail = await withDetail().detail("room:ACM-2:rv1");
    expect(detail.handback?.text).toBe("Done. Two files changed.");
    expect(detail.diff).toEqual({
      files: 3,
      additions: 44,
      deletions: 3,
      top: [
        { path: "src/b.ts", additions: 40, deletions: 2 },
        { path: "src/a.ts", additions: 3, deletions: 1 },
        { path: "README.md", additions: 1, deletions: 0 },
      ],
      uncommitted: false,
    });
    expect(detail.repos).toEqual([{ project: "api", branch: "majhi/ACM-2", into: "main" }]);
    expect(detail.checks).toBe("committed, merges cleanly into main");
    expect(detail.blocked).toBeUndefined();
    const listed = (await withDetail().list()).find((d) => d.id === "room:ACM-2:rv1");
    expect(listed?.suggestion?.reason).toBe(
      "Ready to ship to main: committed, merges cleanly into main. In Acme you decide when work is merged.",
    );
  });

  it("says why Merge cannot be taken and keeps reading when the diff fails", async () => {
    const inbox = withDetail({
      diff: async () => {
        throw new Error("git is busy");
      },
      shipOptions: async () => ({
        merge: { ok: false, why: "Nothing is committed on the task branch." },
        mergePush: ok,
        push: ok,
        mr: ok,
        done: ok,
      }),
    });
    const detail = await inbox.detail("room:ACM-2:rv1");
    expect(detail.diff?.error).toBe("git is busy");
    expect(detail.blocked).toEqual({ merge: "Nothing is committed on the task branch." });
  });

  it("gives a question card its full questions and refuses a decision that is gone", async () => {
    const detail = await withDetail().detail("room:ACM-1:ask1");
    expect(detail.questions).toEqual([
      { question: "Rebuild or keep the history?", options: ["Keep", "Rebuild"], freeText: false },
    ]);
    await expect(withDetail().detail("room:ACM-1:nope")).rejects.toThrow(/gone/);
  });
});

describe("the captain's recommendation", () => {
  it("is stored by decision id and comes back on the decision", async () => {
    const inbox = service();
    await inbox.recommend({ id: "room:ACM-1:ask1", option: "keep", reason: "keeps a backup branch" }, "acme");
    const found = (await inbox.list()).find((d) => d.id === "room:ACM-1:ask1");
    expect(found?.suggestion).toEqual({ option: "keep", reason: "keeps a backup branch", by: "captain" });
    // A second opinion replaces the first.
    await inbox.recommend({ id: "room:ACM-1:ask1", option: "rebuild", reason: "cleaner" }, "acme");
    expect((await inbox.list()).find((d) => d.id === "room:ACM-1:ask1")?.suggestion?.option).toBe("rebuild");
  });

  it("is refused for another workspace's decision, a missing option and a decision with no buttons", async () => {
    const inbox = service();
    await expect(
      inbox.recommend({ id: "room:ACM-1:ask1", option: "keep", reason: "x" }, "globex"),
    ).rejects.toThrow(/another workspace/);
    await expect(
      inbox.recommend({ id: "room:ACM-1:ask1", option: "nope", reason: "x" }, "acme"),
    ).rejects.toThrow(/one of: rebuild, keep/);
    await expect(inbox.recommend({ id: "room:ACM-1:sr1", option: "x", reason: "x" }, "acme")).rejects.toThrow(
      /no buttons/,
    );
    expect(repo.all().size).toBe(0);
  });

  it("is a tool of the captain only: the plain command refuses everyone", async () => {
    const handlers = inboxHandlers(service());
    const ctx: CommandContext = {
      command: "decisions.recommend",
      meta: { actor: { kind: "owner" } },
    };
    await expect(
      handlers["decisions.recommend"]({ id: "room:ACM-1:ask1", option: "keep", reason: "x" }, ctx),
    ).rejects.toThrow(/tool of the captain/);
  });

  it("is forgotten once its decision is gone for two weeks", async () => {
    repo.set("room:ACM-1:old", { option: "a", reason: "x" }, "2026-09-01T00:00:00.000Z");
    repo.set("room:ACM-1:ask1", { option: "keep", reason: "x" }, "2026-09-01T00:00:00.000Z");
    await service().list();
    expect([...repo.all().keys()]).toEqual(["room:ACM-1:ask1"]);
  });
});
