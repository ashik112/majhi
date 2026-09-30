import type { AgentSession } from "@majhi/acp";
import {
  type AgentFrontmatter,
  DecisionSettingsSchema,
  type OptionValue,
  type PricesConfig,
  type Task,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { Decisions, ModelPick, ModelPickRequest } from "../decisions/api.ts";
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

function decisions(answer: (r: ModelPickRequest) => ModelPick | undefined) {
  const asked: ModelPickRequest[] = [];
  const d: Decisions = {
    pickModel: async (r) => {
      asked.push(r);
      return answer(r);
    },
    attachTool: () => undefined,
    revoke: () => {},
    decide: async () => undefined,
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
const task = { id: "ACM-1", brief: "Plan the release" } as Task;
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
    instructions: "Plan and review.",
    task,
    settings,
    prices: over.prices ?? {},
    ...(over.replaced === undefined ? {} : { replaced: over.replaced }),
    ...(over.hidden === undefined ? {} : { hidden: over.hidden }),
  });

const price = (output: number) => ({ input: 1, output, cache_read: 0, cache_write: 0 });
const pick = (model?: [string, number], effort?: [string, number]): ModelPick => ({
  decisionId: "d1",
  provider: "laya",
  by: "Laya",
  ...(model === undefined ? {} : { model: { id: model[0], confidence: model[1] } }),
  ...(effort === undefined ? {} : { effort: { id: effort[0], confidence: effort[1] } }),
});

describe("pickForSession", () => {
  it("asks about the merged families with the role, and says what was picked", async () => {
    const { s, set } = session(CLAUDE, EFFORTS);
    const { d, asked } = decisions(() => pick(["claude-opus-5-5", 0.71], ["high", 0.6]));
    const out = await run(d, s);
    expect(asked[0]?.models.map((o) => o.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
    ]);
    expect(asked[0]?.efforts.map((o) => o.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(asked[0]?.models[0]?.label).toBe("claude-opus-5-5: most capable");
    expect(set).toEqual({ model: "claude-opus-5-5", thought_level: "high" });
    expect(out.applied).toEqual({ model: "claude-opus-5-5", effort: "high", decisionId: "d1" });
    expect(out.line).toBe(
      "@acme-lead (Lead). Models offered: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-4-5. Laya picked claude-opus-5-5 (most capable, 0.71). Efforts offered: low, medium, high, xhigh, max. Laya picked high (0.60).",
    );
  });

  it("falls back to the tier when an answer is under its floor, and says so", async () => {
    const { s, set } = session(CLAUDE, EFFORTS);
    const { d } = decisions(() => pick(["claude-sonnet-5-5", 0.49], ["high", 0.3997]));
    const out = await run(d, s);
    // Lead: most capable model, highest effort. The model answer reached its floor, the effort did not.
    expect(set).toEqual({ model: "claude-sonnet-5-5", thought_level: "max" });
    expect(out.line).toContain("Laya picked claude-sonnet-5-5 (balanced, 0.49).");
    expect(out.line).toContain(
      "Laya's high was 0.39, under the 0.40 floor, so it fell back to highest (max).",
    );
  });

  it("uses the separate floors from the settings", async () => {
    const { s, set } = session(CLAUDE, EFFORTS);
    const { d } = decisions(() => pick(["claude-sonnet-5-5", 0.45], ["high", 0.45]));
    const strict = DecisionSettingsSchema.parse({ model_floor: 0.5, effort_floor: 0.4 });
    const out = await pickForSession({
      decisions: d,
      session: s,
      fm: fm(),
      instructions: "",
      task,
      settings: strict,
      prices: {},
    });
    expect(set).toEqual({ model: "claude-opus-5-5", thought_level: "high" });
    expect(out.line).toContain("under the 0.50 floor, so it fell back to most capable (claude-opus-5-5)");
  });

  it("falls back to the tier when no provider answers", async () => {
    const { s, set } = session(CLAUDE, EFFORTS);
    const out = await run(undefined, s, { fm: { role: "Tester" } });
    expect(set).toEqual({ model: "claude-haiku-4-5", thought_level: "low" });
    expect(out.applied).toEqual({ model: "claude-haiku-4-5", effort: "low" });
    expect(out.line).toContain("No provider answered, so it fell back to cheapest (claude-haiku-4-5).");
    expect(out.line).toContain("No provider answered, so it fell back to lowest (low).");
  });

  it("layers the agent tier over the org tier over majhi's", async () => {
    const { s, set } = session(CLAUDE, EFFORTS);
    await pickForSession({
      decisions: undefined,
      session: s,
      fm: fm({ role: "Builder", tier: { effort: "lowest" } }),
      instructions: "",
      task,
      settings,
      prices: {},
      orgTiers: { Builder: { model: "cheapest", effort: "highest" } },
    });
    expect(set).toEqual({ model: "claude-haiku-4-5", thought_level: "low" });
  });

  it("keeps the CLI default when the tier cannot resolve for lack of prices", async () => {
    const codex = opts("acme-code-5", "acme-code-3", "acme-fast-1");
    const { s, set } = session(codex, opts("low", "medium", "high"));
    const out = await run(undefined, s);
    expect(set).toEqual({ thought_level: "high" });
    expect(out.applied).toEqual({ effort: "high" });
    expect(out.line).toContain(
      "so it fell back to most capable, but no offered model has a price to rank by, so the tier cannot resolve. Add price rows for these models to use tiers. It kept the CLI default.",
    );
    const rows = {
      "acme-code-5": { input: 2, output: 12, cache_read: 0, cache_write: 0 },
      "acme-fast-1": { input: 1, output: 8, cache_read: 0, cache_write: 0 },
    };
    const priced = session(codex, opts("low", "medium", "high"));
    await run(undefined, priced.s, { prices: rows });
    expect(priced.set.model).toBe("acme-code-5");
  });

  it("uses a lone option without asking, and asks only for the `auto` parts", async () => {
    const { s, set } = session(opts("default", "claude-opus-5-5"), EFFORTS);
    const { d, asked } = decisions(() => pick(undefined, ["medium", 0.9]));
    const out = await run(d, s);
    expect(asked[0]?.models).toEqual([]);
    expect(set).toEqual({ model: "claude-opus-5-5", thought_level: "medium" });
    expect(out.line).toContain("Only claude-opus-5-5 is offered.");

    const fixed = session(CLAUDE, EFFORTS);
    const again = decisions(() => pick(undefined, ["medium", 0.9]));
    const only = await run(again.d, fixed.s, { fm: { model: "claude-opus-5-5" } });
    expect(again.asked[0]?.models).toEqual([]);
    expect(fixed.set).toEqual({ thought_level: "medium" });
    expect(only.line).not.toContain("Models offered");
  });

  it("narrows to the agent's models list before merging", async () => {
    const { s } = session(CLAUDE, EFFORTS);
    const { d, asked } = decisions(() => undefined);
    await run(d, s, { fm: { models: ["claude-sonnet-5-5", "claude-haiku-4-5"] } });
    expect(asked[0]?.models.map((o) => o.id)).toEqual(["claude-sonnet-5-5", "claude-haiku-4-5"]);
  });

  it("reports an option the session refuses", async () => {
    const { s } = session(CLAUDE, EFFORTS, "claude-haiku-4-5");
    const out = await run(undefined, s, { fm: { role: "Tester" } });
    expect(out.warnings).toEqual(["Could not apply the pick (claude-haiku-4-5): not offered"]);
    expect(out.applied).toEqual({ effort: "low" });
  });

  it("falls back when the provider throws", async () => {
    const { s } = session(CLAUDE, EFFORTS);
    const d: Decisions = {
      pickModel: async () => {
        throw new Error("down");
      },
      attachTool: () => undefined,
      revoke: () => {},
      decide: async () => undefined,
    };
    const out = await run(d, s);
    expect(out.line).toContain("No provider answered, so it fell back to most capable");
  });

  describe("with efforts that belong to the model (Codex)", () => {
    // codex-cli 0.158.0 through codex-acp 2.0.0: setting the model swaps in that model's efforts.
    const CODEX = opts("gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5");
    const FULL = opts("low", "medium", "high", "xhigh", "max", "ultra");
    const SHORT = opts("low", "medium", "high", "xhigh", "max");
    const effortsOf = (model: string) => (model.endsWith("luna") ? SHORT : FULL);

    function codexSession(start = "gpt-6-astra") {
      let model = start;
      const set: Record<string, string> = {};
      const s = {
        get models() {
          return { models: CODEX, efforts: effortsOf(model), defaultModel: model };
        },
        setOption: async (category: string, value: string) => {
          if (category === "model") model = value;
          else if (!effortsOf(model).some((e) => e.id === value)) throw new Error("invalid params");
          set[category] = value;
        },
      } as unknown as AgentSession;
      return { s, set };
    }

    it("falls back on the new model's list when the picked effort is not offered with it", async () => {
      const { s, set } = codexSession();
      const { d } = decisions(() => pick(["gpt-6-luna", 0.8], ["ultra", 0.9]));
      const out = await run(d, s);
      expect(set).toEqual({ model: "gpt-6-luna", thought_level: "max" });
      expect(out.warnings).toEqual([]);
      expect(out.line).toContain("Efforts offered: low, medium, high, xhigh, max.");
      expect(out.line).toContain(
        "Laya's ultra is not offered with gpt-6-luna, so it fell back to highest (max).",
      );
    });

    it("resolves the effort tier on the new model's list", async () => {
      const { s, set } = codexSession();
      const { d } = decisions(() => pick(["gpt-6-luna", 0.8]));
      await run(d, s);
      expect(set).toEqual({ model: "gpt-6-luna", thought_level: "max" });
    });

    it("keeps a picked effort the new model offers", async () => {
      const { s, set } = codexSession("gpt-6-luna");
      const { d } = decisions(() => pick(["gpt-6-sol", 0.8], ["ultra", 0.7]));
      const out = await run(d, s);
      expect(set).toEqual({ model: "gpt-6-sol", thought_level: "ultra" });
      expect(out.line).toContain("Laya picked ultra (0.70).");
    });
  });

  it("leaves out a model the catalog marks as replaced, when its replacement is offered", async () => {
    const codex = opts("gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5");
    const { s } = session(codex, opts("low", "high"));
    const { d, asked } = decisions(() => undefined);
    const out = await run(d, s, {
      replaced: new Map([
        ["gpt-5.6-sol", "gpt-6-sol"],
        ["gpt-5.5", "gpt-6-sol"],
      ]),
    });
    expect(asked[0]?.models.map((o) => o.id)).toEqual(["gpt-6-sol", "gpt-6-luna"]);
    expect(out.line).toContain(
      "Left out: gpt-5.6-sol (replaced by gpt-6-sol), gpt-5.5 (replaced by gpt-6-sol).",
    );
  });

  it("keeps a replaced model whose replacement is not offered", async () => {
    const { s } = session(opts("gpt-5.6-sol", "gpt-6-luna"), opts("low", "high"));
    const { d, asked } = decisions(() => undefined);
    const out = await run(d, s, { replaced: new Map([["gpt-5.6-sol", "gpt-6-sol"]]) });
    expect(asked[0]?.models.map((o) => o.id)).toEqual(["gpt-5.6-sol", "gpt-6-luna"]);
    expect(out.line).not.toContain("Left out");
  });

  it("does not use a hidden model for the pick or the tiers", async () => {
    const rows = { "a-1": price(30), "b-1": price(20), "c-1": price(10) };
    const { s, set } = session(opts("a-1", "b-1", "c-1"), opts("low", "high"));
    const { d, asked } = decisions(() => undefined);
    const out = await run(d, s, { prices: rows, hidden: ["a-1"] });
    expect(asked[0]?.models.map((o) => o.id)).toEqual(["b-1", "c-1"]);
    // Lead falls back to the most capable one that is left.
    expect(set.model).toBe("b-1");
    expect(out.line).toContain("Left out: a-1 (hidden).");
  });

  it("lets an agent that names a hidden model in `models` have it", async () => {
    const { s } = session(opts("a-1", "b-1", "c-1"), opts("low", "high"));
    const { d, asked } = decisions(() => undefined);
    await run(d, s, { hidden: ["a-1"], fm: { models: ["a-1", "b-1"] } });
    expect(asked[0]?.models.map((o) => o.id)).toEqual(["a-1", "b-1"]);
  });
});
