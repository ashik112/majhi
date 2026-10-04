import { createHash } from "node:crypto";
import { type Answer, type DecideRequest, stateText } from "@majhi/shared";

/** How long a cached answer is reused. Inputs are hashed, so a long time is safe. */
export const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

/** What a cached call keeps: the provider's answers before the gate, and the log row they belong to. */
export interface CachedDecision {
  id: string;
  answers: Record<string, Answer>;
  trimmed: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  /** hits / (hits + misses), 0 before the first lookup. */
  hitRate: number;
  ttlHours: number;
}

/** The state with runs of white space collapsed, so a re-typed task with the same words repeats. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The key of a request: the question kinds with their instructions, options and order runs as the
 * schema filled them in, the state text, and the versions that change what the model answers (its
 * checkpoint and the calibration). Two requests with the same key get the same answer from a
 * deterministic provider, so the second one need not ask.
 */
export function cacheKey(request: DecideRequest, versions: { model: string; calibration: string }): string {
  const fitted = {
    state: normalize(stateText(request.state)),
    questions: request.questions,
    model: versions.model,
    calibration: versions.calibration,
  };
  return createHash("sha256").update(JSON.stringify(fitted)).digest("hex");
}

/**
 * An exact-match cache for deterministic providers (Laya). It holds the answers before the gate, so
 * a change to the bar applies to a repeat as well. In memory: a restart starts it empty, which only
 * costs the first repeat.
 */
export class DecisionCache {
  private readonly entries = new Map<string, { at: number; value: CachedDecision }>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CACHE_TTL_MS,
  ) {}

  get(key: string): CachedDecision | undefined {
    const entry = this.entries.get(key);
    if (entry !== undefined && this.now() - entry.at <= this.ttlMs) {
      this.hits += 1;
      // Most recently used last, so the oldest goes first when the cache is full.
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.value;
    }
    if (entry !== undefined) this.entries.delete(key);
    this.misses += 1;
    return undefined;
  }

  set(key: string, value: CachedDecision): void {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.entries.size,
      hitRate: total === 0 ? 0 : this.hits / total,
      ttlHours: Math.round(this.ttlMs / 3_600_000),
    };
  }
}
