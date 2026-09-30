import type { Answer, DecideRequest, DecideState, LayaQuestion, ProviderId } from "@majhi/shared";

export interface ProviderOutcome {
  answers: Record<string, Answer>;
  /** True for self-reported probabilities. */
  estimated: boolean;
  trimmed: boolean;
  /** What the provider got, when it differs from the request: the fitted state and its own questions. For the log. */
  sent?: { state: DecideState; questions: Record<string, LayaQuestion> };
  /** The provider's version or checkpoint, when known. For the log. */
  version?: string;
}

export interface DecisionProvider {
  readonly id: ProviderId;
  /** A plain reason when the provider cannot answer now, else undefined. */
  unavailable(): Promise<string | undefined>;
  /** Answers every question or throws. Never returns a partial set. */
  decide(request: DecideRequest): Promise<ProviderOutcome>;
}
