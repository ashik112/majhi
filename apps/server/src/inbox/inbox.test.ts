import type { BudgetAsk, CommandName, RoomItem } from "@majhi/shared";
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
    budgets: [],
    signedOut: [],
    recommendations: new Map(),
    ...over,
  };
}

describe("building decisions", () => {
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
    expect(out[0]?.options.map((o) => o.id)).toEqual(["merge", "done", "changes"]);
    expect(isDecisionItem({ ...paused, reason: "offline" }, subjects["ACM-2"] as never)).toBe(false);
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
    answerBudget: async (s, a) => void log.push(`budget ${s} ${a}`),
    decideDraft: async (id, d) => void log.push(`draft ${id} ${d}`),
    decideBatch: async (o, c, d) => void log.push(`batch ${o} ${c} ${d}`),
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
  ])("routes the approval %s / %s to its own path", async (id, option, text, expected) => {
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
});
