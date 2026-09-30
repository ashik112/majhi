import type { DecideRequest, OptionValue } from "@majhi/shared";
import type { Decisions } from "../decisions/api.ts";

/**
 * Some efforts change how the agent works, not how hard it thinks: one that hands work to the
 * agent's own sub-agents duplicates the team, hides work from the room and burns tokens. An `auto`
 * pick and the effort tiers must not land on one. The decision provider judges each option from the
 * CLI's own description, so no effort name is in the code. An effort set by hand is never checked.
 */

/** Most questions one call takes. */
const CHUNK = 8;

/** Answers kept for the life of the server, by tool, effort id and description. Only answered ones. */
const answered = new Map<string, boolean>();

const keyOf = (tool: string, o: OptionValue) => `${tool}\0${o.id}\0${o.description?.trim() ?? ""}`;

export function delegationQuestion(id: string): string {
  return `Does the effort option "${id}" change how the agent works, for example by handing work to its own sub-agents, rather than only how hard it thinks?`;
}

export interface EffortCheck {
  /** Ids that change how the agent works: left out of the pick and of every tier. */
  flagged: Set<string>;
  /** True when an option with a description could not be judged, so it was left in. */
  unchecked: boolean;
}

/** Forgets the answers. For tests. */
export function clearEffortChecks(): void {
  answered.clear();
}

/**
 * Judges the effort options that have a description (an option with none gives nothing to judge, so
 * it stays). An answer of yes at or above `minConfidence` flags the option. Answers are cached, so a
 * session start asks at most once. With no provider or no answer nothing is flagged.
 */
export async function checkEfforts(input: {
  decisions: Decisions | undefined;
  tool: string;
  options: readonly OptionValue[];
  minConfidence: number;
  task: string;
  agent: string;
}): Promise<EffortCheck> {
  const { tool, minConfidence } = input;
  const judged = input.options.filter((o) => o.id !== "default" && o.description?.trim());
  const todo = judged.filter((o) => !answered.has(keyOf(tool, o)));
  let unchecked = false;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const request: DecideRequest = {
      state: chunk.map((o) => `${o.id}: ${o.description?.trim()}`).join("\n"),
      questions: Object.fromEntries(
        chunk.map((o, n) => [`e${n}`, { type: "noul" as const, instructions: delegationQuestion(o.id) }]),
      ),
    };
    const result = await input.decisions
      ?.decide(request, { use: "model-pick", task: input.task, agent: input.agent })
      .catch(() => undefined);
    chunk.forEach((o, n) => {
      const a = result?.answers[`e${n}`];
      if (a === undefined || typeof a.value !== "boolean") {
        unchecked = true;
        return;
      }
      answered.set(keyOf(tool, o), a.value && a.confidence >= minConfidence);
    });
  }
  const flagged = new Set(judged.filter((o) => answered.get(keyOf(tool, o)) === true).map((o) => o.id));
  return { flagged, unchecked };
}
