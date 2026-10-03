import type { DecideRequest, DecisionResult, ProviderId } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { DecisionProvider, ProviderOutcome } from "./providers.ts";

export type ChainResult = Omit<DecisionResult, "id" | "durationMs"> &
  Pick<ProviderOutcome, "sent" | "version">;

/**
 * How long each provider gets before the chain moves on. A provider that runs over is not
 * cancelled: Laya's first question loads the model, and letting that finish warms it for the next
 * call, which then answers in milliseconds.
 */
export const PROVIDER_BUDGET_MS: Readonly<Record<ProviderId, number>> = {
  laya: 3_000,
  jev: 5_000,
  acp: 30_000,
  rules: 1_000,
};

/** The whole chain, before it skips what is left except the rules. */
export const CHAIN_DEADLINE_MS = 30_000;

export interface ChainOptions {
  budgets?: Partial<Record<ProviderId, number>>;
  deadlineMs?: number;
  breaker?: CircuitBreaker;
}

/**
 * Stops asking a provider that keeps failing. After `threshold` failures in a row (an error or a
 * timeout) it is skipped for `coolDownMs`; then one call is tried, and a success closes it again.
 * The rules provider never opens, since it is the safe default.
 */
export class CircuitBreaker {
  private readonly state = new Map<ProviderId, { failures: number; openUntil: number }>();

  constructor(
    private readonly threshold = 3,
    private readonly coolDownMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** A plain reason while the provider is skipped, else undefined. */
  skipReason(id: ProviderId): string | undefined {
    const s = this.state.get(id);
    if (s === undefined || s.openUntil <= this.now()) return undefined;
    const seconds = Math.ceil((s.openUntil - this.now()) / 1000);
    return `it failed ${s.failures} times in a row, so it is skipped for ${seconds} more seconds`;
  }

  failed(id: ProviderId): void {
    if (id === "rules") return;
    const s = this.state.get(id) ?? { failures: 0, openUntil: 0 };
    const failures = s.failures + 1;
    this.state.set(id, {
      failures,
      openUntil: failures >= this.threshold ? this.now() + this.coolDownMs : 0,
    });
  }

  succeeded(id: ProviderId): void {
    this.state.delete(id);
  }

  /** For `decisions.status`: the providers that are skipped now. */
  open(): ProviderId[] {
    return [...this.state.keys()].filter((id) => this.skipReason(id) !== undefined);
  }
}

class Timeout extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout(`it did not answer in ${Math.max(1, ms / 1000)} s`)), ms);
  });
  // The work may still finish after the chain moved on; its late result is dropped without a trace.
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Tries the providers in `order`. A provider that is unavailable, fails, runs over its budget or
 * sits in a circuit breaker's cool-down is recorded in `skipped` with its reason, and the next one
 * answers. Once the deadline passes only the rules provider is tried, so a caller is never left
 * waiting on a slow fallback. Throws when none answers.
 */
export async function runChain(
  order: readonly ProviderId[],
  providers: Readonly<Record<ProviderId, DecisionProvider>>,
  request: DecideRequest,
  options: ChainOptions = {},
): Promise<ChainResult> {
  const skipped: ChainResult["skipped"] = [];
  const started = Date.now();
  const deadline = options.deadlineMs ?? CHAIN_DEADLINE_MS;
  for (const id of order) {
    const provider = providers[id];
    const left = deadline - (Date.now() - started);
    if (id !== "rules" && left <= 0) {
      skipped.push({ provider: id, reason: "the chain ran out of time" });
      continue;
    }
    const cooling = options.breaker?.skipReason(id);
    if (cooling !== undefined) {
      skipped.push({ provider: id, reason: cooling });
      continue;
    }
    const budget =
      id === "rules"
        ? PROVIDER_BUDGET_MS.rules
        : Math.min(options.budgets?.[id] ?? PROVIDER_BUDGET_MS[id], left);
    try {
      const reason = await within(provider.unavailable(), budget);
      if (reason !== undefined) {
        skipped.push({ provider: id, reason });
        continue;
      }
      const outcome = await within(provider.decide(request), budget);
      options.breaker?.succeeded(id);
      return {
        answers: outcome.answers,
        provider: id,
        skipped,
        trimmed: outcome.trimmed,
        estimated: outcome.estimated,
        ...(outcome.sent === undefined ? {} : { sent: outcome.sent }),
        ...(outcome.version === undefined ? {} : { version: outcome.version }),
      };
    } catch (err) {
      options.breaker?.failed(id);
      skipped.push({ provider: id, reason: errorMessage(err) });
    }
  }
  const why = skipped.map((s) => `${s.provider}: ${s.reason}`).join("; ");
  throw new UserError(`No decision provider could answer (${why || "none is in the order"}).`, 409);
}
