import type { AgentSession } from "@majhi/acp";
import {
  type AgentFrontmatter,
  type DecisionSettings,
  type EffortTier,
  type ModelTier,
  type PricesConfig,
  resolveTier,
  type Task,
  type TiersPatch,
} from "@majhi/shared";
import type { Decisions, ModelPick, PickAnswer } from "../decisions/api.ts";
import { errorMessage } from "../errors.ts";
import {
  effortForTier,
  effortOptions,
  labelModels,
  modelForTier,
  normalizeOffered,
} from "./model-options.ts";

export interface PickResult {
  /** One line for the room: what was offered, what was picked and why. */
  line: string;
  /** What was applied, for the run record. `decisionId` is set when a provider was asked. */
  applied?: { model?: string; effort?: string; decisionId?: string };
  /** Options the session refused. */
  warnings: string[];
}

/** How a part of the pick turned out. */
interface Outcome {
  /** The id to apply, or undefined to keep the CLI default. */
  id?: string;
  /** The sentence for the room. */
  text: string;
}

/**
 * Model and effort for an `auto` agent at session start (SPEC 5.1, 5.12). Each list is made fit for a
 * question first: models merged into families and labelled by price, efforts without `default`. The
 * decision provider picks from what is left, with the role in the question. An answer under its floor,
 * or no answer, falls back to the role's tier (agent, then org, then majhi). The pick is applied with
 * `setOption`. When even the tier cannot resolve, the CLI default stays and the line says why.
 */
export async function pickForSession(input: {
  decisions: Decisions | undefined;
  session: AgentSession;
  fm: AgentFrontmatter;
  instructions: string;
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
  const modelOptions = labelModels(models, input.prices);
  const effortList = effortOptions(offered.efforts);
  const askModel = fm.model === "auto" && modelOptions.length >= 2;
  const askEffort = fm.effort === "auto" && effortList.length >= 2;
  const tier = resolveTier(fm.role, fm.tier, input.orgTiers?.[fm.role], settings.tiers[fm.role]);

  const pick: ModelPick | undefined =
    decisions === undefined || (!askModel && !askEffort)
      ? undefined
      : await decisions
          .pickModel({
            task: task.id,
            agent: fm.id,
            role: fm.role,
            context: `${task.brief}\n\n${input.instructions}`.trim(),
            models: askModel ? modelOptions : [],
            efforts: askEffort ? effortList : [],
          })
          .catch(() => undefined);

  const parts: string[] = [`@${fm.id} (${fm.role}).`];
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

  if (fm.model === "auto" && modelOptions.length > 0) {
    const list = `Models offered: ${modelOptions.map((o) => o.id).join(", ")}.${left.length === 0 ? "" : ` Left out: ${left.join(", ")}.`}`;
    const outcome: Outcome = (() => {
      const [only] = modelOptions;
      if (modelOptions.length === 1 && only !== undefined)
        return { id: only.id, text: `Only ${only.id} is offered.` };
      const rank = (id: string) => modelOptions.find((o) => o.id === id)?.rank;
      return decided("model", pick, pick?.model, settings.model_floor, tier.model, rank, () =>
        modelForTier(models, tier.model, input.prices),
      );
    })();
    parts.push(list, outcome.text);
    await apply("model", outcome.id);
  }
  // Efforts belong to the model: an adapter may offer another list once the model changed (Codex
  // does), so the effort is resolved against what the session offers now.
  const efforts = session.models.efforts;
  const effortsNow = effortOptions(efforts);
  if (fm.effort === "auto" && effortsNow.length > 0) {
    const list = `Efforts offered: ${effortsNow.map((o) => o.id).join(", ")}.`;
    const answer = pick?.effort;
    const outcome: Outcome = (() => {
      const [only] = effortsNow;
      if (effortsNow.length === 1 && only !== undefined)
        return { id: only.id, text: `Only ${only.id} is offered.` };
      const fallback = () => effortForTier(efforts, tier.effort);
      if (pick !== undefined && answer !== undefined && !effortsNow.some((o) => o.id === answer.id)) {
        const model = session.models.defaultModel;
        const why = `${pick.by}'s ${answer.id} is not offered${model === undefined ? "" : ` with ${model}`}`;
        return fellBack("effort", why, tier.effort, fallback);
      }
      return decided("effort", pick, answer, settings.effort_floor, tier.effort, () => undefined, fallback);
    })();
    parts.push(list, outcome.text);
    await apply("thought_level", outcome.id);
  }
  if (parts.length === 1) parts.push("Nothing to pick: the session offers no choice.");
  if (applied.model !== undefined || applied.effort !== undefined) {
    if (pick !== undefined && (askModel || askEffort)) applied.decisionId = pick.decisionId;
    return { line: parts.join(" "), applied, warnings };
  }
  return { line: parts.join(" "), warnings };
}

/** The pick if it reaches the floor; else the tier, with the sentence that says so. */
function decided(
  what: "model" | "effort",
  pick: ModelPick | undefined,
  answer: PickAnswer | undefined,
  floor: number,
  tier: ModelTier | EffortTier,
  rank: (id: string) => string | undefined,
  fallback: () => string | undefined,
): Outcome {
  if (pick !== undefined && answer !== undefined && answer.confidence >= floor) {
    const label = rank(answer.id);
    const detail = `${label === undefined ? "" : `${label}, `}${answer.confidence.toFixed(2)}`;
    return { id: answer.id, text: `${pick.by} picked ${answer.id} (${detail}).` };
  }
  const why =
    pick === undefined || answer === undefined
      ? "No provider answered"
      : `${pick.by}'s ${answer.id} was ${below(answer.confidence)}, under the ${floor.toFixed(2)} floor`;
  return fellBack(what, why, tier, fallback);
}

/** The tier's pick, with `why` it was needed; the CLI default when even the tier cannot resolve. */
function fellBack(
  what: "model" | "effort",
  why: string,
  tier: ModelTier | EffortTier,
  fallback: () => string | undefined,
): Outcome {
  const tierName = tier.replace("-", " ");
  const id = fallback();
  if (id !== undefined) return { id, text: `${why}, so it fell back to ${tierName} (${id}).` };
  const reason =
    what === "model"
      ? "no offered model has a price to rank by, so the tier cannot resolve. Add price rows for these models to use tiers"
      : "the session offers no effort to choose from";
  return { text: `${why}, so it fell back to ${tierName}, but ${reason}. It kept the CLI default.` };
}

/** Two decimals, cut instead of rounded: a 0.3997 must not read as 0.40 under a 0.40 floor. */
function below(confidence: number): string {
  return (Math.floor(confidence * 100 + 1e-9) / 100).toFixed(2);
}
