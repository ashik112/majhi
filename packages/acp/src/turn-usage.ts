/**
 * Token usage of one prompt turn (SPEC Phase 2c). Adapters differ in what they report, so each tool
 * says how its `PromptResponse.usage` counts:
 *
 * - `turn`: the counts cover this turn only. claude-agent-acp sums every model call of the turn;
 *   codex-acp reports its last model call.
 * - `cumulative`: running totals for the session, as the ACP schema describes them. The turn's
 *   share is the change since the previous turn; a total that goes down starts over.
 *
 * Cost comes from `usage_update.cost`, a running total for the adapter process in USD. The turn's
 * cost is how much it grew while the turn ran. A turn with no cost report has no cost here; the
 * server prices it from its table instead.
 */
export type UsageMode = "turn" | "cumulative";

/** The ACP `Usage` object, as far as majhi reads it. */
export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** False when the agent reported no token counts for this turn. */
  reported: boolean;
  /** Dollars the agent reported for this turn. */
  costUsd?: number;
  /** The model the agent says it used, else the session's current model. */
  model?: string;
}

interface Counts {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const ZERO: Counts = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function count(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function counts(u: AcpUsage): Counts {
  return {
    inputTokens: count(u.inputTokens),
    outputTokens: count(u.outputTokens),
    reasoningTokens: count(u.thoughtTokens),
    cacheReadTokens: count(u.cachedReadTokens),
    cacheWriteTokens: count(u.cachedWriteTokens),
  };
}

const KEYS = Object.keys(ZERO) as (keyof Counts)[];

/** One per session. `begin` before each prompt, `end` with its response. */
export class TurnMeter {
  private previous: Counts | undefined;
  private cost: number | undefined;
  private costAtStart = 0;
  private costSeen = false;
  private model: string | undefined;

  constructor(private readonly mode: UsageMode) {}

  /** A `usage_update` arrived. Cost in any currency but USD is ignored: the server prices it instead. */
  note(update: {
    cost?: { amount: number; currency: string } | null | undefined;
    model?: string | undefined;
  }): void {
    const c = update.cost;
    if (c && c.currency.toUpperCase() === "USD" && Number.isFinite(c.amount) && c.amount >= 0) {
      this.cost = c.amount;
      this.costSeen = true;
    }
    if (update.model) this.model = update.model;
  }

  begin(): void {
    this.costAtStart = this.cost ?? 0;
    this.costSeen = false;
    this.model = undefined;
  }

  end(usage: AcpUsage | null | undefined, currentModel: string | undefined): TurnUsage {
    let tokens: Counts = ZERO;
    if (usage) {
      const now = counts(usage);
      if (this.mode === "turn") tokens = now;
      else {
        const before = this.previous;
        const restarted = before !== undefined && KEYS.some((k) => now[k] < before[k]);
        tokens =
          before === undefined || restarted
            ? now
            : (Object.fromEntries(KEYS.map((k) => [k, now[k] - before[k]])) as unknown as Counts);
        this.previous = now;
      }
    }
    const out: TurnUsage = { ...tokens, reported: usage !== null && usage !== undefined };
    if (this.costSeen && this.cost !== undefined) {
      const grew = this.cost - this.costAtStart;
      out.costUsd = grew >= 0 ? grew : this.cost;
    }
    const model = this.model ?? currentModel;
    if (model) out.model = model;
    return out;
  }
}
