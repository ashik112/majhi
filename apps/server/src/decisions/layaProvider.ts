import type { DecideRequest, LayaStatus } from "@majhi/shared";
import type { HostLink } from "../host/link.ts";
import { fromLayaAnswer, toLayaQuestion } from "./layaMap.ts";
import type { DecisionProvider } from "./providers.ts";
import { trimState } from "./trim.ts";

/** The first question loads the model, which takes a few seconds. */
const DECIDE_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 3_000;

/** Laya on the owner's Mac, through the host helper. */
export class LayaProvider implements DecisionProvider {
  readonly id = "laya" as const;

  constructor(private readonly host: HostLink | undefined) {}

  /** The helper's own answer, or its last poll header, or a reason it is not there. */
  async status(): Promise<LayaStatus> {
    const link = this.host;
    if (link === undefined || !link.isConnected()) {
      return { state: "unsupported", detail: "The host helper is not connected, so Laya cannot run." };
    }
    try {
      return await link.call("decisions.status", {}, STATUS_TIMEOUT_MS);
    } catch {
      return (
        link.status().info?.laya ?? { state: "unsupported", detail: "This host helper is too old for Laya." }
      );
    }
  }

  async install(): Promise<LayaStatus> {
    const link = this.host;
    if (link === undefined || !link.isConnected()) {
      return {
        state: "unsupported",
        detail: "The host helper is not connected, so Laya cannot be installed.",
      };
    }
    return link.call("decisions.install", {}, STATUS_TIMEOUT_MS);
  }

  async unavailable(): Promise<string | undefined> {
    const link = this.host;
    if (link === undefined || !link.isConnected()) return "The host helper is not connected";
    // The poll header is at most 25 seconds old, which is fine for skipping.
    const laya = link.status().info?.laya;
    if (laya === undefined) return "This host helper is too old for Laya";
    if (laya.state === "ready" || laya.state === "loaded") return undefined;
    return laya.detail ?? `Laya is ${laya.state.replace("-", " ")}`;
  }

  async decide(request: DecideRequest) {
    const link = this.host;
    if (link === undefined) throw new Error("No host helper");
    const { text, trimmed } = trimState(request.state);
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => [key, toLayaQuestion(q)]),
    );
    const result = await link.call("decide", { state: text, questions }, DECIDE_TIMEOUT_MS);
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => {
        const raw = result.answers[key];
        if (raw === undefined) throw new Error(`Laya gave no answer for "${key}".`);
        return [key, fromLayaAnswer(q, raw)];
      }),
    );
    return { answers, estimated: false, trimmed };
  }
}
