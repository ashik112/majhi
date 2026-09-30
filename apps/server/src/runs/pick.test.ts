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
  over: { fm?: Partial<AgentFrontmatter>; prices?: PricesConfig } = {},
) =>
  pickForSession({
    decisions: d,
    session: s,
    fm: fm(over.fm),
    instructions: "Plan and review.",
    task,
    settings,
    prices: over.prices ?? {},
  });

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
    const codex = opts("gpt-5.5-codex", "gpt-5.3-codex", "gpt-5.5");
    const { s, set } = session(codex, opts("low", "medium", "high"));
    const out = await run(undefined, s);
    expect(set).toEqual({ thought_level: "high" });
    expect(out.applied).toEqual({ effort: "high" });
    expect(out.line).toContain(
      "so it fell back to most capable, but no offered model has a price to rank by, so the tier cannot resolve. Add price rows for these models to use tiers. It kept the CLI default.",
    );
    const rows = {
      "gpt-5.5-codex": { input: 2, output: 12, cache_read: 0, cache_write: 0 },
      "gpt-5.5": { input: 1, output: 8, cache_read: 0, cache_write: 0 },
    };
    const priced = session(codex, opts("low", "medium", "high"));
    await run(undefined, priced.s, { prices: rows });
    expect(priced.set.model).toBe("gpt-5.5-codex");
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
});
