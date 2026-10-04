import type { CaptainRepo } from "./repo.ts";

/**
 * G1: every captain action is keyed by the state it acts on, and a repeat with the same key does
 * nothing. The keys live in `captain_keys` (and, for chore actions, in the log's own `key`), and are
 * taken with one insert on a unique key, so two calls with the same key make one action, also after
 * a restart. The formats:
 * - ship: `ship:<task>:<repo@head,...>>repo@base,...` (the chore and the lane share it)
 * - answer: `answer:<task>:<card item id>`
 * - tell: `tell:<task>:<agent>:<id of the agent's last turn>`
 */

/** The key of one answer to one card, whoever gives it. */
export const answerKey = (task: string, item: string): string => `answer:${task}:${item}`;

/** The key of a note to an agent of a task: a new note needs a turn of the agent since the last one. */
export const tellKey = (task: string, agent: string, lastTurn: number): string =>
  `tell:${task}:${agent}:${lastTurn}`;

/** The state of a task in review a ship acts on: each repo's head and the base it goes onto. */
export const shipState = (t: { heads: string; bases?: string | undefined }): string =>
  t.bases === undefined || t.bases === "" ? t.heads : `${t.heads}>${t.bases}`;

/** The result of doing something once for a key. `why` says what the key found when it was not taken. */
export type Once<T> = { done: true; value: T } | { done: false; why: "repeat" | "in-flight" };

/**
 * Runs `run` for the key unless it was taken. A run that throws gives the key back, so the action
 * can be tried again; one that returns settles it for good.
 */
export async function once<T>(
  repo: Pick<CaptainRepo, "claimKey" | "settleKey" | "releaseKey">,
  at: Date,
  key: { kind: string; key: string; task?: string | undefined },
  run: () => Promise<T>,
): Promise<Once<T>> {
  const claim = repo.claimKey(key.kind, key.key, key.task, at.toISOString());
  if (claim !== "taken") return { done: false, why: claim };
  try {
    const value = await run();
    repo.settleKey(key.key);
    return { done: true, value };
  } catch (err) {
    repo.releaseKey(key.key);
    throw err;
  }
}

/** What answering a card found: it was answered now, or why it was not (typed, so a caller never reads prose). */
export type AnswerResult = { answered: true } | { answered: false; why: "repeat" | "in-flight" };

/**
 * Answers a card once. A second answer to the same card, by any captain path (a chore, a rule, the
 * lane), is a no-op with `answered: false`: not an error the caller retries on.
 */
export async function answerOnce(
  repo: Pick<CaptainRepo, "claimKey" | "settleKey" | "releaseKey">,
  at: Date,
  card: { task: string; item: string },
  answer: () => Promise<unknown>,
): Promise<AnswerResult> {
  const r = await once(
    repo,
    at,
    { kind: "answer", key: answerKey(card.task, card.item), task: card.task },
    answer,
  );
  return r.done ? { answered: true } : { answered: false, why: r.why };
}
