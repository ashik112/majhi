import type { AgentSession } from "@majhi/acp";
import {
  type AgentFrontmatter,
  DecisionSettingsSchema,
  type OptionValue,
  type PricesConfig,
  type Task,
} from "@majhi/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { Decisions, RateTaskRequest, TaskRating } from "../decisions/api.ts";
import type { Difficulty } from "./difficulty.ts";
import { clearEffortChecks } from "./effort-check.ts";
import { pickForSession } from "./pick.ts";

const opts = (...ids: string[]): OptionValue[] => ids.map((id) => ({ id, name: id }));
const CLAUDE = opts(
  "default",
  "sonnet",
  "opus",
  "haiku",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-4-5",
);
const EFFORTS = opts("default", "low", "medium", "high", "xhigh", "max");

function session(models: OptionValue[], efforts: OptionValue[], refuse?: string) {
  const set: Record<string, string> = {};
  const s = {
    models: { models, efforts },
    setOption: async (category: string, value: string) => {
      if (value === refuse) throw new Error("not offered");
      set[category] = value;
    },
  } as unknown as AgentSession;
  return { s, set };
}

function decisions(
  answer: (r: RateTaskRequest) => TaskRating | undefined,
  decide: Decisions["decide"] = async () => undefined,
) {
  const asked: RateTaskRequest[] = [];
  const d: Decisions = {
    rateTask: async (r) => {
      asked.push(r);
      return answer(r);
    },
    attachTool: () => undefined,
    revoke: () => {},
    decide,
  };
  return { d, asked };
}

const fm = (over: Partial<AgentFrontmatter> = {}) =>
  ({
    id: "acme-lead",
    scope: "acme",
    role: "Lead",
    account: "acme-claude",
    model: "auto",
    effort: "auto",
    ...over,
  }) as AgentFrontmatter;
const task = {
  id: "ACM-1",
  title: "Plan the release",
  brief: "Plan the release\nCut the branch and write the notes.",
  kind: "code",
  repos: [{ project: "acme-web" }],
} as Task;
const settings = DecisionSettingsSchema.parse({});

const run = (
  d: Decisions | undefined,
  s: AgentSession,
  over: {
    fm?: Partial<AgentFrontmatter>;
    prices?: PricesConfig;
    replaced?: Map<string, string>;
    hidden?: string[];
  } = {},
) =>
  pickForSession({
    decisions: d,
    session: s,
    fm: fm(over.fm),
    task,
    settings,
    prices: over.prices ?? {},
    tool: "codex",
    ...(over.replaced === undefined ? {} : { replaced: over.replaced }),
    ...(over.hidden === undefined ? {} : { hidden: over.hidden }),
  });

const price = (output: number) => ({ input: 1, output, cache_read: 0, cache_write: 0 });
const rated = (level: Difficulty | undefined, confidence: number, counted = true): TaskRating => ({
  ...(level === undefined ? {} : { level }),
  confidence,
  counted,
  why: counted ? "" : `${confidence.toFixed(2)}, under the 0.40 floor`,
  decisionId: "d1",
  provider: "laya",
  by: "Laya",
});

describe("pickForSession", () => {
  it("asks about the task, maps the level onto the role's tiers, and says so", async () => {
    const { s, set } = session(CLAUDE, EFFORTS);
    const { d, asked } = decisions(() => rated("medium", 0.48));
    const out = await run(d, s);
    expect(asked[0]).toEqual({
      task: "ACM-1",
      agent: "acme-lead",
      title: "Plan the release",
      brief: "Plan the release\nCut the branch and write the notes.",
      kind: "code",
      repos: ["acme-web"],
      role: "Lead",
    });
    expect(set).toEqual({ model: "claude-opus-5-5", thought_level: "max" });
    expect(out.applied).toEqual({ model: "claude-opus-5-5", effort: "max", decisionId: "d1" });
    expect(out.line).toBe(
      "@acme-lead (Lead). Laya rated the task medium (0.48): most capable model, highest effort. Models offered: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-4-5. Picked claude-opus-5-5 (most capable). Efforts offered: low, medium, high, xhigh, max. Picked max (highest).",
    );
  });

  it("moves a Builder one step down for little work and one up for a lot", async () => {
    const cases: [Difficulty, { model: string; thought_level: string }][] = [
      ["trivial", { model: "claude-haiku-4-5", thought_level: "low" }],
      ["small", { model: "claude-sonnet-5-5", thought_level: "low" }],
      ["medium", { model: "claude-sonnet-5-5", thought_level: "high" }],
      ["large", { model: "claude-opus-5-5", thought_level: "max" }],
    ];
    for (const [level, want] of cases) {
      const { s, set } = session(CLAUDE, EFFORTS);
      await run(decisions(() => rated(level, 0.6)).d, s, { fm: { role: "Builder" } });
      expect(set).toEqual(want);
    }
  });

  it("keeps the role's tiers when the rating does not count, and says why", async () => {
    const { s, set } = session(CLAUDE, EFFORTS);
    const { d } = decisions(() => rated("large", 0.3, false));
    const out = await run(d, s, { fm: { role: "Builder" } });
    expect(set).toEqual({ model: "claude-sonnet-5-5", thought_level: "high" });
    expect(out.line).toContain(
      "Laya rated the task large, but that does not count (0.30, under the 0.40 floor), so the Builder tiers: balanced model, middle effort.",
    );
  });

  it("keeps the role's tiers when no provider answers", async () => {
    const { s, set } = session(CLAUDE, EFFORTS);
    const out = await run(undefined, s, { fm: { role: "Tester" } });
    expect(set).toEqual({ model: "claude-haiku-4-5", thought_level: "low" });
    expect(out.applied).toEqual({ model: "claude-haiku-4-5", effort: "low" });
    expect(out.line).toContain(
      "No provider rated the task, so the Tester tiers: cheapest model, lowest effort.",
    );
    expect(out.line).toContain("Picked claude-haiku-4-5 (cheapest).");
  });

  it("layers the agent tier over the org tier over majhi's", async () => {
    const { s, set } = session(CLAUDE, EFFORTS);
    await pickForSession({
      decisions: undefined,
      session: s,
      fm: fm({ role: "Builder", tier: { effort: "lowest" } }),
      task,
      settings,
      prices: {},
      tool: "codex",
      orgTiers: { Builder: { model: "cheapest", effort: "highest" } },
    });
    expect(set).toEqual({ model: "claude-haiku-4-5", thought_level: "low" });
  });

  it("estimates the rank from the CLI's order when a model has no price", async () => {
    const codex = opts("acme-code-5", "acme-code-3", "acme-fast-1", "acme-mini-1");
    const { s, set } = session(codex, opts("low", "medium", "high"));
    const out = await run(undefined, s);
    expect(set).toEqual({ model: "acme-code-5", thought_level: "high" });
    expect(out.line).toContain("Picked acme-code-5 (most capable, estimated rank).");
    const cheap = session(codex, opts("low", "medium", "high"));
    await run(undefined, cheap.s, { fm: { role: "Tester" } });
    expect(cheap.set.model).toBe("acme-mini-1");
  });

  it("uses a lone option without asking, and asks only for the `auto` parts", async () => {
    const { s, set } = session(opts("default", "claude-opus-5-5"), EFFORTS);
    const { d, asked } = decisions(() => rated("small", 0.9));
    const out = await run(d, s);
    expect(asked).toHaveLength(1);
    // Lead, small: most capable model and middle effort.
    expect(set).toEqual({ model: "claude-opus-5-5", thought_level: "high" });
    expect(out.line).toContain("Only claude-opus-5-5 is offered.");
    expect(out.line).toContain("Laya rated the task small (0.90): middle effort.");

    const fixed = session(CLAUDE, EFFORTS);
    const again = decisions(() => rated("small", 0.9));
    const only = await run(again.d, fixed.s, { fm: { model: "claude-opus-5-5", effort: "low" } });
    expect(again.asked).toHaveLength(0);
    expect(fixed.set).toEqual({});
    expect(only.line).toBe("@acme-lead (Lead). Nothing to pick: the session offers no choice.");
  });

  it("narrows to the agent's models list before merging", async () => {
    const { s } = session(CLAUDE, EFFORTS);
    const out = await run(undefined, s, { fm: { models: ["claude-sonnet-5-5", "claude-haiku-4-5"] } });
    expect(out.line).toContain("Models offered: claude-sonnet-5-5, claude-haiku-4-5.");
  });

  it("reports an option the session refuses", async () => {
    const { s } = session(CLAUDE, EFFORTS, "claude-haiku-4-5");
    const out = await run(undefined, s, { fm: { role: "Tester" } });
    expect(out.warnings).toEqual(["Could not apply the pick (claude-haiku-4-5): not offered"]);
    expect(out.applied).toEqual({ effort: "low" });
  });

  it("keeps the role's tiers when the provider throws", async () => {
    const { s } = session(CLAUDE, EFFORTS);
    const d: Decisions = {
      rateTask: async () => {
        throw new Error("down");
      },
      attachTool: () => undefined,
      revoke: () => {},
      decide: async () => undefined,
    };
    const out = await run(d, s);
    expect(out.line).toContain("No provider rated the task, so the Lead tiers");
  });

  it("resolves the effort tier on the list the new model offers (Codex)", async () => {
    // codex-cli 0.158.0 through codex-acp 2.0.0: setting the model swaps in that model's efforts.
    const CODEX = opts("gpt-6-astra", "gpt-6-sol", "gpt-6-luna");
    const FULL = opts("low", "medium", "high", "xhigh", "max", "ultra");
    const SHORT = opts("low", "medium", "high", "xhigh", "max");
    let model = "gpt-6-astra";
    const set: Record<string, string> = {};
    const s = {
      get models() {
        return { models: CODEX, efforts: model.endsWith("luna") ? SHORT : FULL, defaultModel: model };
      },
      setOption: async (category: string, value: string) => {
        if (category === "model") model = value;
        set[category] = value;
      },
    } as unknown as AgentSession;
    const out = await run(undefined, s, { fm: { role: "Tester" } });
    expect(set).toEqual({ model: "gpt-6-luna", thought_level: "low" });
    expect(out.line).toContain("Efforts offered: low, medium, high, xhigh, max.");
  });

  it("leaves out a model the catalog marks as replaced, when its replacement is offered", async () => {
    const codex = opts("gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5");
    const { s } = session(codex, opts("low", "high"));
    const out = await run(undefined, s, {
      replaced: new Map([
        ["gpt-5.6-sol", "gpt-6-sol"],
        ["gpt-5.5", "gpt-6-sol"],
      ]),
    });
    expect(out.line).toContain(
      "Models offered: gpt-6-sol, gpt-6-luna. Left out: gpt-5.6-sol (replaced by gpt-6-sol), gpt-5.5 (replaced by gpt-6-sol).",
    );
  });

  it("keeps a replaced model whose replacement is not offered", async () => {
    const { s } = session(opts("gpt-5.6-sol", "gpt-6-luna"), opts("low", "high"));
    const out = await run(undefined, s, { replaced: new Map([["gpt-5.6-sol", "gpt-6-sol"]]) });
    expect(out.line).toContain("Models offered: gpt-5.6-sol, gpt-6-luna.");
    expect(out.line).not.toContain("Left out");
  });

  it("does not use a hidden model for the pick or the tiers", async () => {
    const rows = { "a-1": price(30), "b-1": price(20), "c-1": price(10) };
    const { s, set } = session(opts("a-1", "b-1", "c-1"), opts("low", "high"));
    const out = await run(undefined, s, { prices: rows, hidden: ["a-1"] });
    // Lead falls back to the most capable one that is left.
    expect(set.model).toBe("b-1");
    expect(out.line).toContain("Models offered: b-1, c-1. Left out: a-1 (hidden).");
  });

  it("lets an agent that names a hidden model in `models` have it", async () => {
    const { s } = session(opts("a-1", "b-1", "c-1"), opts("low", "high"));
    const out = await run(undefined, s, { hidden: ["a-1"], fm: { models: ["a-1", "b-1"] } });
    expect(out.line).toContain("Models offered: a-1, b-1.");
  });
});

/** The efforts codex-cli 0.158.0 offers, with the description that matters. */
const CODEX_EFFORTS: OptionValue[] = [
  { id: "low", name: "Low", description: "Fast responses with lighter reasoning" },
  { id: "medium", name: "Medium", description: "Balances speed and reasoning depth" },
  { id: "high", name: "High", description: "Greater reasoning depth for complex problems" },
  { id: "xhigh", name: "Xhigh", description: "Extra high reasoning depth for complex problems" },
  { id: "max", name: "Max", description: "Maximum reasoning depth" },
  { id: "ultra", name: "Ultra", description: "Maximum reasoning with automatic task delegation" },
];

/** A stand-in for the provider: says yes to the option whose line in the state mentions delegation. */
function judge(yes: (line: string) => boolean, confidence = 0.9) {
  const calls: { state: string; keys: string[] }[] = [];
  const decide: Decisions["decide"] = async (request) => {
    calls.push({ state: String(request.state), keys: Object.keys(request.questions) });
    const lines = String(request.state).split("\n");
    return {
      id: "j1",
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key, n) => [key, { value: yes(lines[n] ?? ""), confidence }]),
      ),
      provider: "laya",
      skipped: [],
      trimmed: false,
      estimated: false,
      durationMs: 1,
    };
  };
  return { decide, calls };
}

describe("pickForSession, efforts that change how the agent works", () => {
  beforeEach(() => clearEffortChecks());
  const models = opts("claude-opus-5-5", "claude-sonnet-5-5");

  it("leaves a flagged effort out of the pick and of every tier: highest is max, not ultra", async () => {
    const { s, set } = session(models, CODEX_EFFORTS);
    const j = judge((line) => line.includes("delegation"));
    const { d } = decisions(() => undefined, j.decide);
    const out = await run(d, s);
    expect(set.thought_level).toBe("max");
    expect(out.line).toContain(
      "Efforts offered: low, medium, high, xhigh, max. Left out: ultra (changes how the agent works).",
    );
    expect(out.line).not.toContain("Could not check");
    // One call, one question per option, the option's own description as the state.
    expect(j.calls[0]?.keys).toEqual(["e0", "e1", "e2", "e3", "e4", "e5"]);
    expect(j.calls[0]?.state).toContain("ultra: Maximum reasoning with automatic task delegation");
  });

  it("keeps ultra when nothing is flagged", async () => {
    const { s, set } = session(models, CODEX_EFFORTS);
    const { d } = decisions(() => undefined, judge(() => false).decide);
    const out = await run(d, s);
    expect(set.thought_level).toBe("ultra");
    expect(out.line).not.toContain("Left out");
  });

  it("does not flag on a yes under the confidence floor", async () => {
    const { s, set } = session(models, CODEX_EFFORTS);
    const { d } = decisions(() => undefined, judge((l) => l.includes("delegation"), 0.5).decide);
    await run(d, s);
    expect(set.thought_level).toBe("ultra");
  });

  it("does not trust a weak answer, yes or no, and does not remember it", async () => {
    // The rules provider answers every yes/no with a no at 0.3.
    let mode: "rules" | "laya" = "rules";
    const decide: Decisions["decide"] = async (request) => ({
      id: "j1",
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key, n) => {
          const ultra = String(request.state).split("\n")[n]?.includes("delegation") === true;
          return [
            key,
            mode === "rules" ? { value: false, confidence: 0.3 } : { value: ultra, confidence: 0.9 },
          ];
        }),
      ),
      provider: mode === "rules" ? "rules" : "laya",
      skipped: [],
      trimmed: false,
      estimated: false,
      durationMs: 1,
    });
    const first = session(models, CODEX_EFFORTS);
    const weak = await run(decisions(() => undefined, decide).d, first.s);
    expect(weak.line).toContain("Could not check the effort options, so none were left out.");
    expect(first.set.thought_level).toBe("ultra");

    // Laya is back: the weak "no" was not cached, so ultra is asked about again and flagged.
    mode = "laya";
    const second = session(models, CODEX_EFFORTS);
    const strong = await run(decisions(() => undefined, decide).d, second.s);
    expect(second.set.thought_level).toBe("max");
    expect(strong.line).toContain("Left out: ultra (changes how the agent works).");
    expect(strong.line).not.toContain("Could not check");
  });

  it("leaves nothing out and says so when no provider answers", async () => {
    const { s, set } = session(models, CODEX_EFFORTS);
    const out = await run(undefined, s);
    expect(set.thought_level).toBe("ultra");
    expect(out.line).toContain("Could not check the effort options, so none were left out.");
    const broken = session(models, CODEX_EFFORTS);
    const { d } = decisions(
      () => undefined,
      async () => {
        throw new Error("down");
      },
    );
    const again = await run(d, broken.s);
    expect(again.line).toContain("Could not check the effort options");
  });

  it("asks once per tool, effort and description", async () => {
    const j = judge((line) => line.includes("delegation"));
    const first = session(models, CODEX_EFFORTS);
    await run(decisions(() => undefined, j.decide).d, first.s);
    const second = session(models, CODEX_EFFORTS);
    await run(decisions(() => undefined, j.decide).d, second.s);
    expect(j.calls).toHaveLength(1);
    expect(second.set.thought_level).toBe("max");
    // A changed description is asked again.
    const changed = session(
      models,
      CODEX_EFFORTS.map((o) => (o.id === "ultra" ? { ...o, description: "New text" } : o)),
    );
    await run(decisions(() => undefined, j.decide).d, changed.s);
    expect(j.calls).toHaveLength(2);
    expect(j.calls[1]?.keys).toEqual(["e0"]);
  });

  it("never touches an effort set by hand, and never asks for it", async () => {
    const { s, set } = session(models, CODEX_EFFORTS);
    const j = judge(() => true);
    const { d } = decisions(() => undefined, j.decide);
    await run(d, s, { fm: { effort: "ultra" } });
    expect(j.calls).toHaveLength(0);
    expect(set.thought_level).toBeUndefined();
  });

  it("does not ask about options that have no description", async () => {
    const { s } = session(models, EFFORTS);
    const j = judge(() => true);
    const { d } = decisions(() => undefined, j.decide);
    const out = await run(d, s);
    expect(j.calls).toHaveLength(0);
    expect(out.line).not.toContain("Could not check");
  });
});
