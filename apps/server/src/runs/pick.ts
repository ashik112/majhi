import type { AgentSession } from "@majhi/acp";
import {
  type AgentFrontmatter,
  type DecisionSettings,
  EffortTierSchema,
  ModelTierSchema,
  type OptionValue,
  type PricesConfig,
  type Role,
  resolveTier,
  type Task,
  type Tier,
  type TiersPatch,
} from "@majhi/shared";
import type { Decisions, TaskRating } from "../decisions/api.ts";
import { errorMessage } from "../errors.ts";
import { tierForDifficulty } from "./difficulty.ts";
import { checkEfforts, type EffortCheck } from "./effort-check.ts";
import { effortForTier, effortOptions, modelForTier, normalizeOffered, rankModels } from "./model-options.ts";

export interface PickResult {
  /** One line for the room: how hard the task is, what was offered, what was picked and why. */
  line: string;
  /** What was applied, for the run record. `decisionId` is set when a provider was asked. */
  applied?: { model?: string; effort?: string; decisionId?: string };
  /** Options the session refused. */
  warnings: string[];
}

/**
 * Model and effort for an `auto` agent at session start (SPEC 5.1, 5.12). The decision provider
 * rates how much work the task is for the agent's role; the level moves the role's tiers (agent,
 * then org, then Hub setup) at most one step, and the tiers resolve over what the CLI offers:
 * models merged into families and ranked by price (else the CLI's order), efforts in the CLI's
 * order without `default` and without efforts that change how the agent works. A rating that does
 * not count, or none, keeps the role's tiers. The pick is applied with `setOption`.
 */
export async function pickForSession(input: {
  decisions: Decisions | undefined;
  session: AgentSession;
  fm: AgentFrontmatter;
  task: Task;
  settings: DecisionSettings;
  /** The owner's rows of the price table. */
  prices: PricesConfig;
  /** The task's org's own tiers. */
  orgTiers?: TiersPatch | undefined;
  /** Models the tool's own catalog marks as replaced, by the model that replaced them. */
  replaced?: ReadonlyMap<string, string>;
  /** Models the owner hid on the account. Not used for `auto` picks, unless the agent's `models` names them. */
  hidden?: readonly string[];
}): Promise<PickResult> {
  const { decisions, session, fm, task, settings } = input;
  const offered = session.models;
  const allowed = fm.models ?? [];
  const hidden = input.hidden ?? [];
  // An agent that names a model in `models` gets it, hidden or not.
  const listed =
    allowed.length === 0
      ? offered.models.filter((m) => !hidden.includes(m.id))
      : offered.models.filter((m) => allowed.includes(m.id));
  // A replaced model is left out only when the model that replaced it can be picked instead.
  const left: string[] = offered.models
    .filter((m) => allowed.length === 0 && hidden.includes(m.id))
    .map((m) => `${m.id} (hidden)`);
  const candidates = listed.filter((m) => {
    const by = input.replaced?.get(m.id);
    if (by === undefined || !listed.some((o) => o.id === by)) return true;
    left.push(`${m.id} (replaced by ${by})`);
    return false;
  });
  const models = normalizeOffered(candidates);
  const rank = rankModels(models, input.prices);
  // An effort that changes how the agent works (it hands work to sub-agents) is not for `auto`.
  // Answers are kept for this session start only, so a wrong one is never kept for long.
  const known = new Map<string, boolean>();
  const check = async (list: readonly OptionValue[]): Promise<EffortCheck> =>
    fm.effort === "auto" && effortOptions(list).length >= 2
      ? checkEfforts({
          decisions,
          options: list,
          known,
          task: task.id,
          agent: fm.id,
        })
      : { flagged: new Set(), unchecked: false };
  const without = (list: readonly OptionValue[], c: EffortCheck) => list.filter((o) => !c.flagged.has(o.id));
  const before = await check(offered.efforts);
  const wantModel = fm.model === "auto" && models.length >= 2;
  const wantEffort = fm.effort === "auto" && effortOptions(without(offered.efforts, before)).length >= 2;
  const base = resolveTier(fm.role, fm.tier, input.orgTiers?.[fm.role], settings.tiers[fm.role]);

  const rating =
    decisions === undefined || (!wantModel && !wantEffort)
      ? undefined
      : await decisions
          .rateTask({
            task: task.id,
            agent: fm.id,
            title: task.title,
            brief: task.brief,
            kind: task.kind,
            repos: task.repos.map((r) => r.project),
            role: fm.role,
          })
          .catch(() => undefined);
  const counted = rating?.counted === true && rating.level !== undefined ? rating.level : undefined;
  const tier = counted === undefined ? base : tierForDifficulty(base, counted);

  const parts: string[] = [`@${fm.id} (${fm.role}).`];
  if (wantModel || wantEffort) parts.push(ratingLine(rating, fm.role, tier, wantModel, wantEffort));
  const applied: NonNullable<PickResult["applied"]> = {};
  const warnings: string[] = [];
  const apply = async (category: "model" | "thought_level", id: string | undefined) => {
    if (id === undefined) return;
    try {
      await session.setOption(category, id);
      applied[category === "model" ? "model" : "effort"] = id;
    } catch (err) {
      warnings.push(`Could not apply the pick (${id}): ${errorMessage(err)}`);
    }
  };

  if (fm.model === "auto" && models.length > 0) {
    parts.push(
      `Models offered: ${models.map((m) => m.id).join(", ")}.${left.length === 0 ? "" : ` Left out: ${left.join(", ")}.`}`,
    );
    const [only] = models;
    if (models.length === 1 && only !== undefined) {
      parts.push(`Only ${only.id} is offered.`);
      await apply("model", only.id);
    } else {
      const id = modelForTier(models, tier.model, input.prices);
      const name = tier.model.replace("-", " ");
      parts.push(
        id === undefined
          ? "There is no model to choose from, so it kept the CLI default."
          : `Picked ${id} (${name}${rank.estimated ? ", estimated rank" : ""}).`,
      );
      await apply("model", id);
    }
  }
  // Efforts belong to the model: an adapter may offer another list once the model changed (Codex
  // does), so the effort is resolved against what the session offers now.
  const after = await check(session.models.efforts);
  const efforts = without(session.models.efforts, after);
  const effortsNow = effortOptions(efforts);
  if (fm.effort === "auto" && effortsNow.length > 0) {
    const skipped = [...new Set([...before.flagged, ...after.flagged])].filter((id) =>
      session.models.efforts.some((o) => o.id === id),
    );
    parts.push(
      `Efforts offered: ${effortsNow.map((o) => o.id).join(", ")}.${
        skipped.length === 0 ? "" : ` Left out: ${skipped.join(", ")} (changes how the agent works).`
      }${before.unchecked || after.unchecked ? " Could not check the effort options, so none were left out." : ""}`,
    );
    const [only] = effortsNow;
    if (effortsNow.length === 1 && only !== undefined) {
      parts.push(`Only ${only.id} is offered.`);
      await apply("thought_level", only.id);
    } else {
      const id = effortForTier(efforts, tier.effort);
      parts.push(`Picked ${id} (${tier.effort}).`);
      await apply("thought_level", id);
    }
  }
  if (parts.length === 1) parts.push("Nothing to pick: the session offers no choice.");
  if (rating !== undefined && decisions !== undefined) {
    // For "Wrong pick": the owner names the tier or the model (or effort) that was right.
    decisions.outcome(rating.decisionId, {
      text: parts.slice(1).join(" ").slice(0, 1000),
      fellBack: counted === undefined,
      choices: [
        ...(wantModel
          ? [
              ...ModelTierSchema.options.map((t) => `model tier: ${t}`),
              ...models.map((m) => `model: ${m.id}`),
            ]
          : []),
        ...(wantEffort
          ? [
              ...EffortTierSchema.options.map((t) => `effort tier: ${t}`),
              ...effortsNow.map((o) => `effort: ${o.id}`),
            ]
          : []),
      ].slice(0, 40),
    });
  }
  if (applied.model !== undefined || applied.effort !== undefined) {
    if (rating !== undefined) applied.decisionId = rating.decisionId;
    return { line: parts.join(" "), applied, warnings };
  }
  return { line: parts.join(" "), warnings };
}

/** The sentence on the rating: the level, its confidence and the tiers it gave, or why the role's tiers were kept. */
function ratingLine(
  rating: TaskRating | undefined,
  role: Role,
  tier: Tier,
  model: boolean,
  effort: boolean,
): string {
  const tiers = [
    ...(model ? [`${tier.model.replace("-", " ")} model`] : []),
    ...(effort ? [`${tier.effort} effort`] : []),
  ].join(", ");
  if (rating === undefined) return `No provider rated the task, so the ${role} tiers: ${tiers}.`;
  if (rating.level === undefined)
    return `${rating.by} said no level fits the task, so the ${role} tiers: ${tiers}.`;
  if (!rating.counted)
    return `${rating.by} rated the task ${rating.level}, but that does not count (${rating.why}), so the ${role} tiers: ${tiers}.`;
  return `${rating.by} rated the task ${rating.level} (${rating.confidence.toFixed(2)}): ${tiers}.`;
}
