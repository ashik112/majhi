import type { AgentSession } from "@majhi/acp";
import type { AgentFrontmatter, Task } from "@majhi/shared";
import type { Decisions, ModelPick } from "../decisions/api.ts";
import { errorMessage } from "../errors.ts";

/** Model picks for `auto` agents: Laya spreads probability across similar models, so 0.6 rejects most. */
export const MODEL_PICK_FLOOR = 0.4;

export interface PickResult {
  /** One line for the room: the provider's reason, or why the default stays. */
  line: string;
  pick?: ModelPick;
  /** Options the session refused. */
  warnings: string[];
}

/**
 * Model and effort for an `auto` agent at session start (SPEC 5.1, 5.12): the decision provider
 * picks from what the session offers, narrowed to the agent's `models` list, with each option's
 * description. The pick is applied with `setOption`. Without a confident pick the ACP default stays.
 */
export async function pickForSession(input: {
  decisions: Decisions | undefined;
  session: AgentSession;
  fm: AgentFrontmatter;
  instructions: string;
  task: Task;
}): Promise<PickResult> {
  const { decisions, session, fm, task } = input;
  const kept = `No confident pick for @${fm.id}, so it keeps the agent's default model and effort.`;
  if (decisions === undefined) return { line: kept, warnings: [] };
  const offered = session.models;
  const allowed = fm.models ?? [];
  const models = allowed.length === 0 ? offered.models : offered.models.filter((m) => allowed.includes(m.id));
  const pick = await decisions
    .pickModel({
      task: task.id,
      agent: fm.id,
      role: fm.role,
      context: `${task.brief}\n\n${input.instructions}`.trim(),
      models,
      efforts: offered.efforts,
      pickModel: fm.model === "auto",
      pickEffort: fm.effort === "auto",
      minConfidence: MODEL_PICK_FLOOR,
    })
    .catch(() => undefined);
  if (pick === undefined) return { line: kept, warnings: [] };
  const warnings: string[] = [];
  for (const [category, value] of [
    ["model", pick.model],
    ["thought_level", pick.effort],
  ] as const) {
    if (value === undefined) continue;
    try {
      await session.setOption(category, value);
    } catch (err) {
      warnings.push(`Could not apply the pick (${value}): ${errorMessage(err)}`);
    }
  }
  return { line: pick.reason, pick, warnings };
}
