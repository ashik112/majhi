import type { DecideRequest, DecisionResult, ProviderId } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { DecisionProvider } from "./providers.ts";

export type ChainResult = Omit<DecisionResult, "id" | "durationMs">;

/**
 * Tries the providers in `order`. A provider that is unavailable or fails is recorded in
 * `skipped` with its reason, and the next one answers. Throws when none does.
 */
export async function runChain(
  order: readonly ProviderId[],
  providers: Readonly<Record<ProviderId, DecisionProvider>>,
  request: DecideRequest,
): Promise<ChainResult> {
  const skipped: ChainResult["skipped"] = [];
  for (const id of order) {
    const provider = providers[id];
    try {
      const reason = await provider.unavailable();
      if (reason !== undefined) {
        skipped.push({ provider: id, reason });
        continue;
      }
      const outcome = await provider.decide(request);
      return {
        answers: outcome.answers,
        provider: id,
        skipped,
        trimmed: outcome.trimmed,
        estimated: outcome.estimated,
      };
    } catch (err) {
      skipped.push({ provider: id, reason: errorMessage(err) });
    }
  }
  const why = skipped.map((s) => `${s.provider}: ${s.reason}`).join("; ");
  throw new UserError(`No decision provider could answer (${why || "none is in the order"}).`, 409);
}
