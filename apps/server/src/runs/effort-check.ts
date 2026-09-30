import type { DecideRequestInput, OptionValue } from "@majhi/shared";
import type { Decisions } from "../decisions/api.ts";

/**
 * Some efforts change how the agent works, not how hard it thinks: one that hands work to the
 * agent's own sub-agents duplicates the team, hides work from the room and burns tokens. An `auto`
 * pick and the effort tiers must not land on one. The decision provider judges each option from the
 * CLI's own description, so no effort name is in the code. An effort set by hand is never checked.
 *
 * Each option is its own question, with only that option in the state, as a choice between two
 * described neutral options asked in both orders. On Laya this told Codex's delegating effort apart
 * from every plain one; one choice over all the options, or all of them in one state, did not.
 */

/** The question for one effort option. */
export function delegationQuestion(o: OptionValue): DecideRequestInput {
  return {
    state: { option: o.id, description: o.description?.trim() ?? "" },
    questions: {
      delegates: {
        type: "choice",
        instructions: "What does the effort option do?",
        options: [
          { key: "A", description: "hands work to sub-agents, delegates or splits the work across agents" },
          { key: "B", description: "only changes how much or how fast the agent thinks" },
        ],
        abstain: false,
        orders: "reversed",
      },
    },
  };
}

export interface EffortCheck {
  /** Ids that change how the agent works: left out of the pick and of every tier. */
  flagged: Set<string>;
  /** True when an option with a description could not be judged with enough confidence, so it was left in. */
  unchecked: boolean;
}

const keyOf = (o: OptionValue) => `${o.id}\0${o.description?.trim() ?? ""}`;

/**
 * Judges the effort options that have a description (an option with none gives nothing to judge, so
 * it stays). An answer counts only at or above `minConfidence`, either way: A flags the option, B
 * clears it. Answers go into `known`, which the caller keeps for one session start at most, so a
 * wrong answer never outlives it. A weaker answer, or none, leaves the option in and sets `unchecked`.
 */
export async function checkEfforts(input: {
  decisions: Decisions | undefined;
  options: readonly OptionValue[];
  known: Map<string, boolean>;
  minConfidence: number;
  task: string;
  agent: string;
}): Promise<EffortCheck> {
  const { known, minConfidence } = input;
  const judged = input.options.filter((o) => o.id !== "default" && o.description?.trim());
  let unchecked = false;
  for (const o of judged) {
    if (known.has(keyOf(o))) continue;
    const result = await input.decisions
      ?.decide(delegationQuestion(o), { use: "model-pick", task: input.task, agent: input.agent })
      .catch(() => undefined);
    const a = result?.answers.delegates;
    // The rules provider answers with a weak guess: a guess is not a check.
    if (a === undefined || (a.value !== "A" && a.value !== "B") || a.confidence < minConfidence) {
      unchecked = true;
      continue;
    }
    known.set(keyOf(o), a.value === "A");
  }
  const flagged = new Set(judged.filter((o) => known.get(keyOf(o)) === true).map((o) => o.id));
  return { flagged, unchecked };
}
