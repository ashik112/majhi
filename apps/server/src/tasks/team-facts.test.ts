import {
  type AccountModels,
  type AccountStatus,
  type AccountUsage,
  type AccountView,
  type AgentFrontmatter,
  DEFAULT_TIERS,
  type Task,
  type Tier,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { Footprint } from "./planning.ts";
import {
  buildTeamFacts,
  type FactsInput,
  limitsOf,
  type PastPlan,
  priceTier,
  type RunningFacts,
  runningFactsOf,
  teamFactsLines,
  tokensText,
  wakeFacts,
} from "./team-facts.ts";

const NOW = "2026-09-30T11:05:00.000Z";

const task: Task = {
  id: "ACM-7",
  title: "Add health endpoint",
  brief: "Add a health endpoint",
  kind: "code",
  org: "acme",
  status: "running",
  folder: "/Users/owner/tasks/ACM-7",
  repos: [],
  team: ["acme-lead", "acme-builder"],
  mode: "lead",
  overrides: {},
  links: [],
  attachments: [],
  createdAt: NOW,
  updatedAt: NOW,
};

function agent(over: Partial<AgentFrontmatter> & Pick<AgentFrontmatter, "id">): AgentFrontmatter {
  return {
    scope: "acme",
    role: "Builder",
    account: "claude-acme",
    where: ["anywhere"],
    perms: [],
    tools: [],
    connections: [],
    skills: [],
    origin: "owner",
    ...over,
  };
}

const lead = agent({ id: "acme-lead", role: "Lead", model: "claude-opus-4-8", effort: "max" });
const builder = agent({ id: "acme-builder", account: "claude-globex", model: "auto", effort: "auto" });

function view(id: string, status: AccountStatus = "healthy", over: Partial<AccountView> = {}): AccountView {
  return {
    id,
    tool: "claude",
    org: "acme",
    auth: "login",
    home: `/Users/owner/.majhi/accounts/${id}`,
    hiddenModels: [],
    agentCount: 1,
    status,
    ...over,
  };
}

function models(account: string, ids: string[], efforts = ["low", "medium", "high", "max"]): AccountModels {
  return {
    account,
    models: ids.map((id) => ({ id, name: id })),
    efforts: efforts.map((id) => ({ id, name: id })),
    fetchedAt: NOW,
  };
}

const offered = new Map([
  ["claude-acme", models("claude-acme", ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"])],
  ["claude-globex", models("claude-globex", ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"])],
]);

function input(over: Partial<FactsInput> = {}): FactsInput {
  return {
    task,
    now: NOW,
    agents: [lead, builder],
    boss: undefined,
    accounts: new Map([view("claude-acme"), view("claude-globex")].map((v) => [v.id, v])),
    offered,
    prices: {},
    runs: new Map(),
    tierOf: (fm): Tier => DEFAULT_TIERS[fm.role],
    running: [],
    ...over,
  };
}

const member = (facts: ReturnType<typeof buildTeamFacts>, id: string) => {
  const found = facts.members.find((m) => m.id === id);
  if (found === undefined) throw new Error(`no member ${id}`);
  return found;
};

describe("the model of a member", () => {
  it("takes the owner's override over the latest run over the agent file", () => {
    const withOverride = {
      ...task,
      overrides: { "acme-lead": { model: "claude-sonnet-4-6", effort: "low" } },
    };
    expect(member(buildTeamFacts(input()), "acme-lead").model).toBe("claude-opus-4-8");
    const ran = new Map([["acme-lead", { model: "claude-haiku-4-5", effort: "medium" }]]);
    expect(member(buildTeamFacts(input({ runs: ran })), "acme-lead")).toMatchObject({
      model: "claude-haiku-4-5",
      effort: "medium",
    });
    // The owner changed the model after the run started: the run row still has the old one.
    const overridden = member(buildTeamFacts(input({ task: withOverride, runs: ran })), "acme-lead");
    expect(overridden).toMatchObject({ model: "claude-sonnet-4-6", effort: "low", auto: false });
  });

  it("treats an auto override as auto, over the agent file, unless the agent has run", () => {
    const autoOverride = { ...task, overrides: { "acme-lead": { model: "auto" } } };
    expect(member(buildTeamFacts(input({ task: autoOverride })), "acme-lead")).toMatchObject({
      model: "claude-opus-4-8",
      auto: true,
      tier: "most capable",
    });
    const ran = new Map([["acme-lead", { model: "claude-haiku-4-5" }]]);
    expect(member(buildTeamFacts(input({ task: autoOverride, runs: ran })), "acme-lead")).toMatchObject({
      model: "claude-haiku-4-5",
      auto: false,
    });
  });

  it("gives an auto agent that has not run the model of its fallback tier, marked auto", () => {
    const b = member(buildTeamFacts(input()), "acme-builder");
    // Builder: balanced model, middle effort, among three priced models.
    expect(b).toMatchObject({ model: "claude-sonnet-4-6", auto: true, effort: "high", tier: "balanced" });
    const cheap = buildTeamFacts(input({ tierOf: () => ({ model: "cheapest", effort: "lowest" }) }));
    expect(member(cheap, "acme-builder")).toMatchObject({ model: "claude-haiku-4-5", effort: "low" });
    const ran = new Map([["acme-builder", { model: "claude-opus-4-8" }]]);
    expect(member(buildTeamFacts(input({ runs: ran })), "acme-builder")).toMatchObject({
      model: "claude-opus-4-8",
      auto: false,
    });
  });

  it("says an auto agent with nothing cached is picked when it starts", () => {
    const facts = buildTeamFacts(input({ offered: new Map() }));
    expect(teamFactsLines(facts).find((l) => l.startsWith("- @acme-builder"))).toContain(
      "auto, picked when it starts",
    );
    expect(wakeFacts(facts)).toContain(
      "- @acme-builder (Builder): auto, picked when it starts, default effort",
    );
  });

  it("has no model for an auto agent when nothing is cached, and skips hidden models", () => {
    const none = buildTeamFacts(input({ offered: new Map() }));
    expect(member(none, "acme-builder")).toMatchObject({ model: undefined, auto: true, effort: undefined });
    const hidden = buildTeamFacts(
      input({
        accounts: new Map([
          ["claude-acme", view("claude-acme")],
          ["claude-globex", view("claude-globex", "healthy", { hiddenModels: ["claude-sonnet-4-6"] })],
        ]),
      }),
    );
    // Two models are left; the balanced pick is the cheaper of the two.
    expect(member(hidden, "acme-builder").model).toBe("claude-haiku-4-5");
  });
});

describe("price tier", () => {
  it("labels a priced offered list and gives the price", () => {
    const list = models("claude-acme", ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);
    expect(priceTier("claude-opus-4-8", list, {})).toEqual({
      tier: "most capable",
      price: { input: 5, output: 25 },
    });
    expect(priceTier("claude-haiku-4-5", list, {})).toMatchObject({ tier: "cheapest and fastest" });
    expect(priceTier("claude-sonnet-4-6", list, {})).toMatchObject({ tier: "balanced" });
  });

  it("matches a dated or suffixed id to the offered one, and prices a model with no offered list", () => {
    const list = models("claude-acme", ["claude-opus-4-8", "claude-haiku-4-5"]);
    expect(priceTier("claude-opus-4-8[1m]", list, {}).tier).toBe("most capable");
    expect(priceTier("claude-haiku-4-5-20260101", undefined, {})).toEqual({ price: { input: 1, output: 5 } });
  });

  it("marks the rank as estimated when an offered model has no price", () => {
    const list = models("claude-acme", ["acme-large", "acme-small"]);
    expect(priceTier("acme-large", list, {})).toEqual({ tier: "most capable", estimated: true });
    expect(priceTier("acme-small", list, {})).toEqual({ tier: "cheapest and fastest", estimated: true });
  });

  it("gives no tier with fewer than two models", () => {
    const one = models("claude-acme", ["claude-opus-4-8"]);
    expect(priceTier("claude-opus-4-8", one, {})).toEqual({ price: { input: 5, output: 25 } });
  });

  it("prefers the owner's price row", () => {
    const owner = { "claude-opus-4-8": { input: 1, output: 2, cache_read: 0, cache_write: 0 } };
    expect(priceTier("claude-opus-4-8", undefined, owner).price).toEqual({ input: 1, output: 2 });
  });
});

describe("limits", () => {
  const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({
    models: [],
    estimated: false,
    updatedAt: NOW,
    ...over,
  });

  it("reads what is left of the window and the week, with their resets", () => {
    const l = limitsOf(
      "login",
      "healthy",
      usage({
        window: { usedPct: 38, resetsAt: "2026-09-30T13:00:00Z" },
        weekly: { usedPct: 19.6, resetsAt: "2026-10-05T09:00:00Z" },
      }),
    );
    expect(l).toEqual({
      kind: "plan",
      status: "healthy",
      estimated: false,
      window: { leftPct: 62, resetsAt: "2026-09-30T13:00:00Z" },
      weekly: { leftPct: 80, resetsAt: "2026-10-05T09:00:00Z" },
      models: [],
    });
  });

  it("never goes below zero and keeps the per-model weekly windows", () => {
    const l = limitsOf(
      "login",
      "at-limit",
      usage({ window: { usedPct: 104 }, models: [{ label: "Opus", usedPct: 30 }], estimated: true }),
    );
    expect(l).toMatchObject({
      kind: "plan",
      estimated: true,
      window: { leftPct: 0 },
      models: [{ label: "Opus", leftPct: 70 }],
    });
  });

  it("has no plan windows for an API key, and says so when usage was not read", () => {
    expect(limitsOf("api-key", "healthy", undefined)).toEqual({ kind: "api-key" });
    expect(limitsOf("login", "unknown", undefined)).toEqual({ kind: "unknown" });
    expect(limitsOf("login", "needs-login", undefined)).toMatchObject({
      kind: "plan",
      status: "needs-login",
    });
  });
});

describe("who could join", () => {
  const reviewer = agent({ id: "acme-reviewer", role: "Reviewer" });
  const rooted = agent({ id: "root-helper", scope: "root", role: "Builder", account: "claude-acme" });
  const globex = agent({ id: "globex-dev", scope: "globex", where: ["globex"], account: "claude-acme" });
  const boss = agent({ id: "boss", scope: "root", role: "Root" });
  const tired = agent({ id: "acme-aardvark", account: "claude-tired" });

  it("lists the org's agents not on the team, without the boss or agents that cannot work there", () => {
    const facts = buildTeamFacts(
      input({ agents: [lead, builder, reviewer, rooted, globex, boss], boss: "boss" }),
    );
    expect(facts.joinable.map((m) => m.id)).toEqual(["acme-reviewer", "root-helper"]);
  });

  it("puts usable accounts first, then org agents before root ones, then by id", () => {
    const accounts = new Map(
      [view("claude-acme"), view("claude-globex"), view("claude-tired", "at-limit")].map((v) => [v.id, v]),
    );
    const facts = buildTeamFacts(input({ agents: [lead, builder, tired, rooted, reviewer], accounts }));
    expect(facts.joinable.map((m) => m.id)).toEqual(["acme-reviewer", "root-helper", "acme-aardvark"]);
  });

  it("lists at most six", () => {
    const many = Array.from({ length: 9 }, (_, i) => agent({ id: `acme-b${i}` }));
    expect(buildTeamFacts(input({ agents: [lead, builder, ...many] })).joinable).toHaveLength(6);
  });
});

describe("running tasks", () => {
  const other = { id: "ACM-3", title: "Faster scroll", team: ["acme-lead", "acme-builder"] };
  const accountOf = (id: string) => (id === "acme-lead" ? "claude-acme" : undefined);
  const paths = (n: number) => Array.from({ length: n }, (_, i) => `apps/web/src/file-${i}.ts`);

  it("caps the files at six and counts the rest", () => {
    const fp: Footprint[] = [{ task: "ACM-3", project: "web", paths: paths(9), changed: true }];
    const r = runningFactsOf(other, accountOf, fp, "little");
    expect(r.projects).toEqual([{ project: "web", files: paths(6), more: 3, changed: true }]);
    expect(r.agents).toEqual([
      { id: "acme-lead", account: "claude-acme" },
      { id: "acme-builder", account: "unknown" },
    ]);
  });

  it("shows only the files a worktree changed, and carries the overlap level", () => {
    const fp: Footprint[] = [
      { task: "ACM-3", project: "web", paths: ["a.ts", "named.ts"], changed: true, changedPaths: ["a.ts"] },
      { task: "ACM-3", project: "api", paths: ["src/api"], changed: false },
      { task: "ACM-9", project: "web", paths: ["other.ts"], changed: true },
    ];
    const r = runningFactsOf(other, accountOf, fp, "heavy");
    expect(r.projects).toEqual([
      { project: "web", files: ["a.ts"], more: 0, changed: true },
      { project: "api", files: ["src/api"], more: 0, changed: false },
    ]);
    expect(r.overlap).toBe("heavy");
  });

  it("keeps the order given and at most six tasks", () => {
    const running: RunningFacts[] = Array.from({ length: 8 }, (_, i) => ({
      id: `ACM-${i}`,
      title: "t",
      agents: [],
      projects: [],
      overlap: "none",
    }));
    expect(buildTeamFacts(input({ running })).running.map((r) => r.id)).toEqual(
      running.slice(0, 6).map((r) => r.id),
    );
  });
});

describe("the TASK.md sections", () => {
  const reviewer = agent({ id: "acme-reviewer", role: "Reviewer", model: "claude-opus-4-8" });
  const accounts = new Map([
    [
      "claude-acme",
      view("claude-acme", "healthy", {
        usage: {
          models: [{ label: "Opus", usedPct: 30 }],
          estimated: false,
          updatedAt: NOW,
          window: { usedPct: 38, resetsAt: "2026-09-30T13:00:00Z" },
          weekly: { usedPct: 20, resetsAt: "2026-10-05T09:00:00Z" },
        },
      }),
    ],
    ["claude-globex", view("claude-globex", "healthy", { auth: "api-key" })],
  ]);
  const running: RunningFacts[] = [
    {
      id: "ACM-3",
      title: "Faster scroll",
      agents: [{ id: "acme-lead", account: "claude-acme" }],
      projects: [{ project: "web", files: ["apps/web/a.ts", "apps/web/b.ts"], more: 3, changed: true }],
      overlap: "little",
    },
    {
      id: "ACM-4",
      title: "Retry runs",
      agents: [{ id: "acme-builder", account: "claude-globex" }],
      projects: [{ project: "api", files: ["apps/server/src/runs"], more: 0, changed: false }],
      overlap: "unknown",
    },
  ];

  it("writes a lead-mode task's members, joinable agents and running tasks", () => {
    const facts = buildTeamFacts(input({ agents: [lead, builder, reviewer], accounts, running }));
    expect(teamFactsLines(facts)).toEqual([
      "## Team facts",
      "",
      "As of 11:05 UTC. majhi rewrites this each time it wakes @acme-lead.",
      "",
      "- @acme-lead (Lead): claude-opus-4-8, most capable, $5 in and $25 out per M tokens, effort max. Account claude-acme: 5-hour 62% left (resets 13:00 UTC), weekly 80% left (resets Mon 09:00 UTC), weekly Opus 70% left.",
      "- @acme-builder (Builder): claude-sonnet-4-6 (auto, its fallback tier), balanced, $3 in and $15 out per M tokens, effort high. Account claude-globex: API key, pays per token, no plan limits.",
      "",
      "Could join (mention one to add it to the team):",
      "- @acme-reviewer (Reviewer): claude-opus-4-8, most capable, $5 in and $25 out per M tokens, default effort. Account claude-acme: 5-hour 62% left (resets 13:00 UTC), weekly 80% left (resets Mon 09:00 UTC), weekly Opus 70% left.",
      "",
      "Running now:",
      "- ACM-3 Faster scroll: @acme-lead on claude-acme. Changed in web: apps/web/a.ts, apps/web/b.ts and 3 more. Overlap with this task: little.",
      "- ACM-4 Retry runs: @acme-builder on claude-globex. Its brief names in api: apps/server/src/runs (nothing changed yet). Overlap with this task: unknown.",
    ]);
  });

  it("says nothing else is running, and leaves out an empty could-join block", () => {
    const text = teamFactsLines(buildTeamFacts(input({ accounts }))).join("\n");
    expect(text).toContain("Running now: nothing else.");
    expect(text).not.toContain("Could join");
    expect(text).not.toContain("## How the lead plans");
  });

  it("words an account that cannot be used", () => {
    const line = (status: AccountStatus, usage?: AccountUsage) =>
      teamFactsLines(
        buildTeamFacts(
          input({
            accounts: new Map([["claude-acme", view("claude-acme", status, usage ? { usage } : {})]]),
          }),
        ),
      )
        .find((l) => l.startsWith("- @acme-lead"))
        ?.split(". Account ")[1];
    expect(line("needs-login")).toBe("claude-acme: needs login.");
    expect(line("unreachable")).toBe("claude-acme: unreachable.");
    expect(line("unknown")).toBe("claude-acme: limits not read yet.");
    expect(
      line("at-limit", {
        models: [],
        estimated: true,
        updatedAt: NOW,
        window: { usedPct: 100, resetsAt: "2026-09-30T13:00:00Z" },
      }),
    ).toBe("claude-acme: at its limit until 13:00 UTC.");
    expect(line("healthy", { models: [], estimated: true, updatedAt: NOW, window: { usedPct: 10 } })).toBe(
      "claude-acme: 5-hour 90% left (majhi's count).",
    );
  });
});

describe("the wake block", () => {
  const usage = (usedPct: number): AccountUsage => ({
    models: [],
    estimated: false,
    updatedAt: NOW,
    window: { usedPct },
    weekly: { usedPct: 20 },
  });
  const at = (usedPct: number) =>
    wakeFacts(
      buildTeamFacts(
        input({
          accounts: new Map([
            ["claude-acme", view("claude-acme", "healthy", { usage: usage(usedPct) })],
            ["claude-globex", view("claude-globex", "healthy", { auth: "api-key" })],
          ]),
        }),
      ),
    );

  it("changes when a window moves by 5% or more, not by 1%", () => {
    expect(at(40)).toBe(at(41));
    expect(at(40)).not.toBe(at(45));
  });

  it("rounds the left percentages to the nearest 5", () => {
    expect(at(38)).toContain("claude-acme 5-hour 60% left, weekly 80% left");
  });

  it("lists the members, who could join and what runs", () => {
    const reviewer = agent({ id: "acme-reviewer", role: "Reviewer", model: "claude-opus-4-8" });
    const running: RunningFacts[] = [
      { id: "ACM-3", title: "t", agents: [], projects: [], overlap: "little" },
      { id: "ACM-4", title: "t", agents: [], projects: [], overlap: "unknown" },
    ];
    const text = wakeFacts(buildTeamFacts(input({ agents: [lead, builder, reviewer], running })));
    expect(text.split("\n")).toEqual([
      "Team facts now (TASK.md has the detail):",
      "- @acme-lead (Lead): claude-opus-4-8, most capable, effort max; claude-acme limits not read yet.",
      "- @acme-builder (Builder): claude-sonnet-4-6, balanced, effort high; claude-globex limits not read yet.",
      "Could join: @acme-reviewer (Reviewer, claude-opus-4-8).",
      "Running: ACM-3 (little overlap), ACM-4.",
    ]);
  });
});

describe("recent plans", () => {
  const past = (id: string, over: Partial<PastPlan> = {}): PastPlan => ({
    task: id,
    title: "Add health endpoint",
    how: ["builders", "reviewer"],
    agents: [
      { agent: "acme-builder", turns: 9, tokens: 1_200_000, outputTokens: 40_000, costUsd: 1.4 },
      { agent: "acme-lead", turns: 4, tokens: 310_000, outputTokens: 20_000, costUsd: 2.1 },
    ],
    ...over,
  });

  it("caps them at three, newest first as given", () => {
    const all = ["ACM-5", "ACM-4", "ACM-3", "ACM-2"].map((id) => past(id));
    expect(buildTeamFacts(input({ past: all })).past.map((p) => p.task)).toEqual(["ACM-5", "ACM-4", "ACM-3"]);
    expect(buildTeamFacts(input()).past).toEqual([]);
  });

  it("writes them after Running now, with the tokens each agent used", () => {
    const lines = teamFactsLines(
      buildTeamFacts(
        input({
          past: [
            past("ACM-5"),
            past("ACM-4", {
              title: "",
              agents: [{ agent: "acme-lead", turns: 1, tokens: 900, outputTokens: 10, costUsd: null }],
            }),
          ],
        }),
      ),
    );
    const at = lines.indexOf("Recent plans, with the tokens each agent used:");
    expect(at).toBeGreaterThan(lines.indexOf("Running now: nothing else."));
    expect(lines.slice(at + 1, at + 3)).toEqual([
      "- ACM-5 Add health endpoint (builders, reviewer): @acme-builder 1.2M tokens ($1.40), @acme-lead 310k tokens ($2.10).",
      "- ACM-4 (builders, reviewer): @acme-lead 900 tokens.",
    ]);
    expect(lines).toHaveLength(at + 3);
  });

  it("leaves the block out when there are none, and out of the wake block", () => {
    expect(teamFactsLines(buildTeamFacts(input())).join("\n")).not.toContain("Recent plans");
    expect(wakeFacts(buildTeamFacts(input({ past: [past("ACM-5")] })))).not.toContain("ACM-5");
  });

  it("writes token counts with k and M, one decimal at most", () => {
    expect([0, 950, 1000, 1449, 310_000, 999_949, 999_950, 1_200_000, 12_340_000].map(tokensText)).toEqual([
      "0",
      "950",
      "1k",
      "1.4k",
      "310k",
      "999.9k",
      "1M",
      "1.2M",
      "12.3M",
    ]);
  });
});
