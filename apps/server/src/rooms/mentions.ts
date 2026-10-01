import type { DecideRequestInput, DecisionResult } from "@majhi/shared";
import { plainText } from "./coordinate.ts";

/**
 * Whether a mention asks a teammate to act (5.3). An agent that names a teammate only to report
 * status or say who it waits on should not wake it: that is how rooms went in circles. The words
 * catch plain status (`statusOnly`); for the rest the decision provider is asked one yes/no per
 * mentioned agent, and only a sure "no" keeps an agent asleep.
 */

/** How much of the message the provider reads: Laya's window is about 512 tokens. */
export const MENTION_STATE_MAX = 1_200;
/** Questions per request, at most; agents past it are woken as before. */
const MAX_ASKED = 8;

/**
 * Whether a sure "no" keeps the agent asleep. On by the labeled eval (`eval/mention-eval.ts`): with
 * `QUIET_MIN_LIFT`, Laya said no sure "no" to a clear request there. Off, a "no" is logged and the
 * agent wakes.
 */
export const QUIET_ON_NO = true;
/**
 * A "no" keeps an agent asleep only this far over chance, stricter than the gate: a wrong "no"
 * leaves work undone, a wrong "yes" costs one turn. In the eval, Laya's wrong "no"s on clear
 * requests were at 0.22 and 0.26, and its right ones at 0.53 and over.
 */
export const QUIET_MIN_LIFT = 0.5;

/**
 * The message as the provider reads it: the agent's own words (no code, no quotes), and when that
 * is too long, the sentences that mention one of `agents`, with the first sentence for context.
 */
export function mentionText(text: string, agents: readonly string[], max = MENTION_STATE_MAX): string {
  const plain = plainText(text).replace(/\s+\n/g, "\n").trim();
  if (plain.length <= max) return plain;
  const sentences = plain.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim() !== "");
  const names = agents.map((a) => `@${a.toLowerCase()}`);
  const kept = sentences.filter((s, i) => i === 0 || names.some((n) => s.toLowerCase().includes(n)));
  const joined = kept.join(" ");
  return joined.length <= max ? joined : `${joined.slice(0, max - 1)}…`;
}

/** The question key for the i-th agent asked. */
function key(i: number): string {
  return `acts_${i + 1}`;
}

/** One yes/no per agent: does the message ask it to do something now? */
export function mentionQuestion(from: string, agents: readonly string[], text: string): DecideRequestInput {
  const asked = agents.slice(0, MAX_ASKED);
  return {
    state: { from: `@${from}`, message: mentionText(text, asked) },
    questions: Object.fromEntries(
      asked.map((agent, i) => [
        key(i),
        {
          type: "noul" as const,
          instructions: `Does the message ask @${agent} to do something now?`,
          criteria: {
            true: `it asks @${agent} to do, fix, check, answer or decide something now`,
            false: `it only reports status or waiting, or names @${agent} without asking it to act`,
          },
        },
      ]),
    ),
  };
}

export interface MentionReading {
  /** A sure yes: woken. */
  act: string[];
  /** A sure no, `QUIET_MIN_LIFT` over chance: not woken when `QUIET_ON_NO`. */
  quiet: string[];
  /** Not sure, or not asked: woken, as before. */
  unsure: string[];
}

/** What the provider said for each agent of `mentionQuestion`. No result reads as unsure. */
export function readMentions(agents: readonly string[], result: DecisionResult | undefined): MentionReading {
  const reading: MentionReading = { act: [], quiet: [], unsure: [] };
  agents.forEach((agent, i) => {
    const a = result?.answers[key(i)];
    if (a === undefined || a.gate?.accepted !== true) reading.unsure.push(agent);
    else if (a.value === true) reading.act.push(agent);
    else if (a.gate.lift >= QUIET_MIN_LIFT) reading.quiet.push(agent);
    else reading.unsure.push(agent);
  });
  return reading;
}
