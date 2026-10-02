import { durationMs, type TurnsPatch, type TurnsSettings } from "@majhi/shared";

/**
 * Turn limits (PRV-96): how long one turn may run, how long it may stay quiet, and how many tool
 * calls it may make. A turn over a limit is cancelled and continues in a fresh session with a
 * handoff note; a task that keeps hitting limits without new commits pauses instead. Pure
 * functions, so the decisions are tested alone.
 */

/** A limit in force, each undefined when off. */
export interface TurnLimits {
  maxMs: number | undefined;
  idleMs: number | undefined;
  maxToolCalls: number | undefined;
}

export type FiredLimit = "length" | "idle" | "tools";

/** Limit hits in a row without new commits before the task pauses instead of continuing. */
export const MAX_STRIKES = 3;

/** Each field in merge order: majhi's, then the org's, then the agent's. */
export function turnLimitsFor(
  global: TurnsSettings,
  org: TurnsPatch | undefined,
  agent: TurnsPatch | undefined,
): TurnLimits {
  const length = agent?.max_length ?? org?.max_length ?? global.max_length;
  const idle = agent?.idle ?? org?.idle ?? global.idle;
  const tools = agent?.max_tool_calls ?? org?.max_tool_calls ?? global.max_tool_calls;
  return {
    maxMs: length === "off" ? undefined : durationMs(length),
    idleMs: idle === "off" ? undefined : durationMs(idle),
    maxToolCalls: tools > 0 ? tools : undefined,
  };
}

export interface TurnState {
  now: number;
  /** When the turn was sent. */
  startedAt: number;
  /** The last output or tool event of the turn, or its start. */
  activeAt: number;
  /** Tool calls the turn made so far. */
  toolCalls: number;
  /** The agent has a running `wait` process: it waits on it, so it is not idle. */
  waiting: boolean;
  /** A permission prompt waits for the owner: no limit cuts the turn under the owner's hand. */
  asking: boolean;
}

/** Which limit the turn is over, or undefined. Length first, then tool calls, then idle. */
export function firedLimit(state: TurnState, limits: TurnLimits): FiredLimit | undefined {
  if (state.asking) return undefined;
  if (limits.maxMs !== undefined && state.now - state.startedAt >= limits.maxMs) return "length";
  if (limits.maxToolCalls !== undefined && state.toolCalls >= limits.maxToolCalls) return "tools";
  if (limits.idleMs !== undefined && !state.waiting && state.now - state.activeAt >= limits.idleMs)
    return "idle";
  return undefined;
}

export interface LimitDecision {
  action: "continue" | "pause";
  /** Hits in a row without new commits, this one included. 0 after a pause, so a resume starts over. */
  strikes: number;
}

/**
 * After a limit cut a turn: continue in a fresh session, or pause when this is the
 * `MAX_STRIKES`th hit in a row whose turn made no new commit.
 */
export function afterLimit(strikesBefore: number, progressed: boolean): LimitDecision {
  const strikes = progressed ? 0 : strikesBefore + 1;
  return strikes >= MAX_STRIKES ? { action: "pause", strikes: 0 } : { action: "continue", strikes };
}

/** `2 hour`, `25 minute`, `90 second`, for "the 2 hour turn limit"; with `plural`, `25 minutes`. */
export function spanWords(ms: number, plural = false): string {
  const [n, unit] =
    ms % 3_600_000 === 0
      ? [ms / 3_600_000, "hour"]
      : ms % 60_000 === 0
        ? [ms / 60_000, "minute"]
        : [Math.round(ms / 1000), "second"];
  return `${n} ${unit}${plural && n !== 1 ? "s" : ""}`;
}

/** "@builder reached the 2 hour turn limit", without a full stop. */
export function limitPhrase(agent: string, fired: FiredLimit, limits: TurnLimits): string {
  switch (fired) {
    case "length":
      return `@${agent} reached the ${spanWords(limits.maxMs ?? 0)} turn limit`;
    case "idle":
      return `@${agent} was idle for ${spanWords(limits.idleMs ?? 0, true)}`;
    case "tools":
      return `@${agent} reached the limit of ${limits.maxToolCalls ?? 0} tool calls in one turn`;
  }
}
