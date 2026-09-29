import type { Answer, DecideRequest, ProviderId } from "@majhi/shared";

export interface ProviderOutcome {
  answers: Record<string, Answer>;
  /** True for self-reported probabilities. */
  estimated: boolean;
  trimmed: boolean;
}

export interface DecisionProvider {
  readonly id: ProviderId;
  /** A plain reason when the provider cannot answer now, else undefined. */
  unavailable(): Promise<string | undefined>;
  /** Answers every question or throws. Never returns a partial set. */
  decide(request: DecideRequest): Promise<ProviderOutcome>;
}
