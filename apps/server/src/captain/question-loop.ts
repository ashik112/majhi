/**
 * The question loop guard (SPEC 5.18). An agent that asks the same thing again and again, in the
 * same task, is stuck, and answering each time only feeds it. Pure.
 */

import type { CallOutcome } from "./call-outcome.ts";

/** An answer the captain gave to an agent in a task. */
export interface PastAnswer {
  at: string;
  /** The question it answered. */
  question: string;
  /** What the captain answered, when known. */
  answer?: string | undefined;
  /** The room card it answered, when known. */
  item?: string | undefined;
  /**
   * How the call behind that card ended. A permission whose call went through is normal use: asking
   * again for the same tool is not a loop. Unknown counts as it always did.
   */
  outcome?: CallOutcome | undefined;
}

/** The same question again within this long is a loop. */
export const NEAR_SAME_MS = 10 * 60_000;
/** The third question from one agent in one task within this long is a loop. */
export const BURST_MS = 5 * 60_000;
/** Questions in a burst that make a loop, counting the new one. */
export const BURST_COUNT = 3;
/** Two questions this alike (shared words over all words) are the same question. */
const SAME = 0.8;

export interface QuestionLoop {
  /** Questions of the loop so far, counting the new one. */
  times: number;
  /** The window it happened in, in minutes. */
  minutes: number;
  /** When the loop began: the oldest answer in it. Stable while the captain answers nothing more. */
  since: string;
  /** The captain's latest answer in it. */
  last: PastAnswer;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w !== ""),
  );
}

/** Whether two questions say the same thing, by their words. */
export function nearSame(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 && y.size === 0) return true;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared) >= SAME;
}

/**
 * Whether a new question from an agent is a loop, given the captain's answers to the same agent in
 * the same task. Two ways: the same question again within ten minutes, or the third question within
 * five minutes, whatever it says.
 */
export function questionLoop(past: readonly PastAnswer[], text: string, now: Date): QuestionLoop | undefined {
  const age = (p: PastAnswer) => now.getTime() - Date.parse(p.at);
  const inLast = (ms: number) =>
    past.filter((p) => p.outcome?.state !== "ok" && age(p) <= ms).sort((a, b) => (a.at < b.at ? -1 : 1));
  const burst = inLast(BURST_MS);
  if (burst.length + 1 >= BURST_COUNT) return describe(burst, 5);
  const recent = inLast(NEAR_SAME_MS);
  if (recent.some((p) => nearSame(p.question, text))) return describe(recent, 10);
  return undefined;
}

function describe(window: PastAnswer[], minutes: number): QuestionLoop | undefined {
  const first = window[0];
  const last = window[window.length - 1];
  if (first === undefined || last === undefined) return undefined;
  return { times: window.length + 1, minutes, since: first.at, last };
}

/** The line the owner reads, and the room shows. */
export function loopLine(agent: string, task: string, loop: Pick<QuestionLoop, "times" | "minutes">): string {
  return `@${agent} keeps asking in ${task} (${loop.times} times in ${loop.minutes} minutes); it may be stuck`;
}

/** The one message to the stuck agent: what it was told, and to stop asking. */
export function nudgeText(task: string, loop: Pick<QuestionLoop, "last">): string {
  const said =
    loop.last.answer === undefined ? "" : ` The captain answered: "${loop.last.answer.slice(0, 200)}".`;
  const out = loop.last.outcome;
  if (out?.state === "failed") {
    const why = out.error === "" ? "with no error text" : `with: "${out.error}"`;
    return `Your call in ${task} keeps failing.${said} The tool failed ${why}. Fix that, or change the input, before asking again. If it needs the owner, say what in the room, once.`;
  }
  return `You asked the same thing in ${task} again and again.${said} Go on with that answer and do not ask it again. If something else blocks you, say what in the room, once.`;
}
