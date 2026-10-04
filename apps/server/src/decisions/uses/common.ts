import type { Answer, DecideRequestInput, ProviderId } from "@majhi/shared";
import type { DecideUse, Decisions } from "../api.ts";

/**
 * Shared by the cheap, frequent Laya uses (SPEC 5.12, "More work for Laya"): each is a decision slot
 * with a rules fallback, and each asks the same way. One call, Laya first, never a paid model unless
 * the use names one, a hard time limit, and an answer that is either usable or nothing. Nothing here
 * acts: it returns what Laya said and whether that answer is allowed to count.
 */

/** What a caller needs of the decision provider. `link` and `resolve` label a decision by its outcome. */
export type LayaDecisions = Pick<Decisions, "decide" | "outcome" | "link" | "resolve">;

/**
 * The calibrated sureness an answer needs before majhi acts on it, on top of the slot's own bar.
 * "Exactly at" counts: 0.9 acts, 0.8999 does not.
 */
export const MIN_ACT = 0.9;

/** How long one ask may take. A slow Laya is the same as no Laya: the fallback runs. */
export const ASK_TIMEOUT_MS = 4_000;

export interface Opinion<V extends string> {
  value: V;
  /** The probability the provider gave, calibrated when the slot is. */
  confidence: number;
  /** True when the slot is live, majhi's gate accepted the answer and it is at least `MIN_ACT` sure. */
  acts: boolean;
  /** True while the slot has no passing eval: the answer is logged and compared, and acts on nothing. */
  shadow: boolean;
  /** The gate's words, "0.93 sure, over the 0.88 bar". */
  why: string;
  decisionId: string;
  provider: ProviderId;
  durationMs: number;
  /** The answer came from the cache of an earlier identical question. */
  cached: boolean;
}

export interface AskOptions {
  /** The providers to try; the rules close the chain. Default: Laya only. */
  order?: readonly ProviderId[];
  /** Hard stop on the whole call, in ms. */
  timeoutMs?: number;
  task?: string;
  agent?: string;
  /** Answers a day from the first provider of `order`. */
  perDay?: number;
  /** Providers whose answer may count. Default: those of `order` except the rules. */
  trust?: readonly ProviderId[];
  /** Overrides `MIN_ACT`, for a provider that reports its own probabilities. */
  minAct?: number;
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  // The work may still finish after the time is up: its late result is dropped without a trace.
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A probability that is a real number between 0 and 1, else undefined. */
function probability(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

/**
 * Asks one question of the decision provider. Resolves undefined when there is no usable answer: no
 * decisions, the rules answered (they only guess), the call failed, ran over its time, the budget is
 * spent, or the value is not one of `values` (a provider that returns garbage). A caller that gets
 * undefined uses its fallback, which is always the safe side.
 */
export async function askOpinion<V extends string>(
  decisions: LayaDecisions | undefined,
  request: DecideRequestInput,
  use: DecideUse["use"],
  key: string,
  values: readonly V[],
  options: AskOptions = {},
): Promise<Opinion<V> | undefined> {
  if (decisions === undefined) return undefined;
  const order = options.order ?? (["laya"] as const);
  const trust = options.trust ?? order.filter((p) => p !== "rules");
  try {
    const result = await within(
      decisions.decide(request, {
        use,
        order,
        ...(options.task === undefined ? {} : { task: options.task }),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.perDay === undefined ? {} : { perDay: options.perDay }),
      }),
      options.timeoutMs ?? ASK_TIMEOUT_MS,
    );
    if (result === undefined || result.provider === "rules") return undefined;
    const answer: Answer | undefined = result.answers[key];
    if (answer === undefined) return undefined;
    const value = String(answer.value);
    const known = values.find((v) => v === value);
    if (known === undefined) return undefined;
    const confidence = probability(answer.gate?.confidence) ?? probability(answer.confidence);
    if (confidence === undefined) return undefined;
    const shadow = answer.gate?.shadow === true;
    return {
      value: known,
      confidence,
      shadow,
      acts:
        trust.includes(result.provider) &&
        answer.gate?.accepted === true &&
        !shadow &&
        confidence >= (options.minAct ?? MIN_ACT),
      why: answer.gate?.reason ?? "no gate",
      decisionId: result.id,
      provider: result.provider,
      durationMs: result.durationMs,
      cached: result.cached === true,
    };
  } catch {
    return undefined;
  }
}

/** Text from outside majhi, cut to a length and with control characters turned to spaces. */
export function clipText(text: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters have no place in a prompt
  const plain = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`;
}
