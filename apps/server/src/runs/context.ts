import type { PromptBlock } from "@majhi/acp";
import type { ContextSettings } from "@majhi/shared";

/**
 * The context budget of one agent session (SPEC 5.13): when to compact, what native
 * compaction must reach, and when to rotate. Pure functions, so the rules are tested alone.
 */
export interface ContextBudget {
  /** Compact when used / size reaches this. */
  compactAt: number;
  /** Native compaction must bring usage under this, else majhi hands off to a fresh session. */
  compactTarget: number;
  /** Replace the session after this many turns. 0 turns it off. */
  maxTurns: number;
}

export interface Usage {
  used: number;
  size: number;
}

/** At most this many compactions while one prompt is handled; then the run pauses with reason error. */
export const MAX_COMPACTIONS_PER_TURN = 2;

/** An image in a prompt counts as this many tokens in estimates. */
export const IMAGE_TOKENS = 1600;

/** What native compaction is told to keep. One line. */
export const COMPACT_NOTE =
  "Keep the task, key decisions, remaining work, files touched, and the next step. Drop old tool output.";

/**
 * `compact_at` in merge order: majhi's default, then the org's, then the agent's. The target and
 * `max_turns` are majhi-wide. When an org or agent threshold is at or under the target, the
 * target becomes half the threshold, so native compaction still has something to reach.
 */
export function budgetFor(
  global: ContextSettings,
  org: { compact_at?: number | undefined } | undefined,
  agent: { compact_at?: number | undefined } | undefined,
): ContextBudget {
  const compactAt = agent?.compact_at ?? org?.compact_at ?? global.compact_at;
  const compactTarget = global.compact_target < compactAt ? global.compact_target : compactAt / 2;
  return { compactAt, compactTarget, maxTurns: global.max_turns };
}

/** About four characters per token, plus a fixed cost per image. */
export function estimateTokens(blocks: readonly PromptBlock[]): number {
  let tokens = 0;
  for (const b of blocks) {
    if (b.type === "text") tokens += Math.ceil(b.text.length / 4);
    else if (b.type === "image") tokens += IMAGE_TOKENS;
    else tokens += Math.ceil((b.uri.length + b.name.length) / 4);
  }
  return tokens;
}

export function estimateText(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * True when the session should compact: the last reading plus the prompt about to be sent
 * (0 at the end of a turn) reaches the threshold. No reading means no signal, so no compaction.
 */
export function needsCompaction(usage: Usage | undefined, budget: ContextBudget, adding = 0): boolean {
  if (usage === undefined || usage.size <= 0) return false;
  return (usage.used + adding) / usage.size >= budget.compactAt;
}

/** True when native compaction brought usage under the target. */
export function reachedTarget(usage: Usage | undefined, budget: ContextBudget): boolean {
  return usage !== undefined && usage.size > 0 && usage.used / usage.size < budget.compactTarget;
}

/** True when the session has run its turns and should be replaced. */
export function rotationDue(turns: number, budget: ContextBudget): boolean {
  return budget.maxTurns > 0 && turns >= budget.maxTurns;
}

/** The agent's native compaction command, as it advertises it over ACP, or undefined. */
export function compactCommand(commands: readonly { name: string }[]): string | undefined {
  const found = commands.find((c) => c.name.replace(/^\//, "") === "compact");
  return found === undefined ? undefined : `/${found.name.replace(/^\//, "")}`;
}

/** Agent errors that mean the context window is full. */
export function isContextError(message: string): boolean {
  return /context (window|length|limit)|prompt is too long|too many tokens|maximum context|context_length_exceeded|input is too long/i.test(
    message,
  );
}

/** Stop reasons after which the session cannot go on as it is. */
export function isRecoveryStop(stopReason: string): boolean {
  return stopReason === "max_tokens" || stopReason === "max_turn_requests";
}

/** `164k`, `18k`, `950`. */
export function shortTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}
