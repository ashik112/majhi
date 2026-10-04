import type { Answer, DecideRequestInput, ProviderId } from "@majhi/shared";
import type { Decisions } from "../decisions/api.ts";

/**
 * Memory escalation (SPEC 5.12 and 5.6). When Laya is not sure about a waiting memory (its verdict, its
 * relation to the nearest fact, or a suspected secret), the owner used to be left with all of them and
 * memory review piled up. Now the smallest model that is set up (the stand-in agent) answers the same
 * question once, within a budget per day, and its answer counts when it clears the same bar. Down, out
 * of budget or unsure again: the memory waits for the owner exactly as before. The stand-in's answer
 * also labels Laya's decision (a "teacher" label), so the slot learns where it was unsure.
 */

/** Answers a day the stand-in may give to memory review. A fact left over waits for the owner, as before. */
export const ESCALATIONS_PER_DAY = 40;

/** The questions that may be escalated. The judgment call and a contradiction stay with the owner by design. */
export const ESCALATABLE = ["verdict", "relation", "private"] as const;
type Name = (typeof ESCALATABLE)[number];

export interface Escalation {
  /** Replacement answers, only for the questions Laya was unsure about. */
  answers: Partial<Record<Name, Answer>>;
  provider: ProviderId;
  /** The escalated decision's id in the log. */
  decision: string;
}

/**
 * Which questions Laya was unsure about: not answered, or answered below the bar. `firm` is the same
 * test the review applies to an answer. The relation is asked only when there is a nearest fact.
 */
export function unsureQuestions(
  answers: Readonly<Record<string, Answer>>,
  firm: (a: Answer) => boolean,
  hasNearest: boolean,
): Name[] {
  const out: Name[] = [];
  const verdict = answers.verdict;
  if (verdict === undefined || !firm(verdict)) out.push("verdict");
  const relation = answers.relation;
  if (hasNearest && relation !== undefined && !firm(relation)) out.push("relation");
  const secret = answers.private;
  // An unsure "no" is the usual case and is let through; an unsure "yes" is worth a second look.
  if (secret?.value === true && !firm(secret)) out.push("private");
  return out;
}

/**
 * Asks the stand-in the review's request once. Resolves undefined when it cannot help: it is down, the
 * day's budget is spent, it ran over its time, or it gave nothing usable. Never throws.
 */
export async function escalateReview(
  decisions: Pick<Decisions, "decide" | "outcome">,
  request: DecideRequestInput,
  unsure: readonly Name[],
  firm: (a: Answer) => boolean,
  options: { perDay: number; task?: string | undefined; agent?: string | undefined },
): Promise<Escalation | undefined> {
  if (unsure.length === 0) return undefined;
  try {
    const result = await decisions.decide(request, {
      use: "memory",
      order: ["acp"],
      perDay: options.perDay,
      ...(options.task === undefined ? {} : { task: options.task }),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    });
    // The rules only guess: whatever they say, it is not an escalation.
    if (result === undefined || result.provider !== "acp") return undefined;
    const answers: Escalation["answers"] = {};
    for (const name of unsure) {
      const a = result.answers[name];
      if (a !== undefined && firm(a)) answers[name] = a;
    }
    if (Object.keys(answers).length === 0) {
      decisions.outcome(result.id, {
        text: "Escalated, and still unsure: left for the owner.",
        fellBack: true,
      });
      return undefined;
    }
    return { answers, provider: result.provider, decision: result.id };
  } catch {
    return undefined;
  }
}
