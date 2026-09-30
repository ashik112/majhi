import type { DecideRequest, LayaStatus } from "@majhi/shared";
import type { HostLink } from "../host/link.ts";
import type { LayaDocker } from "./layaDocker.ts";
import { fromLayaCall, toLayaCall } from "./layaMap.ts";
import type { DecisionProvider } from "./providers.ts";

/** The first question loads the model, which takes a few seconds. */
const DECIDE_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 3_000;

/**
 * Laya: natively on the owner's Mac through the host helper, else in the `laya` Docker service
 * (PyTorch CPU) on Linux, Windows and Intel Macs, or when the native one is not set up (5.12).
 */
export class LayaProvider implements DecisionProvider {
  readonly id = "laya" as const;

  constructor(
    private readonly host: HostLink | undefined,
    private readonly docker?: LayaDocker,
  ) {}

  /** The native one when it is set up or can be, else Laya in Docker when there is one. */
  async status(): Promise<LayaStatus> {
    const native = await this.nativeStatus();
    if (this.docker === undefined || native.state === "ready" || native.state === "loaded") return native;
    if (native.state === "installing" || native.state === "downloading") return native;
    const docker = await this.docker.status();
    // On a Mac with Apple silicon the native one is the goal: offer it until Docker's is built.
    if (docker.state === "not-installed" && native.state === "not-installed") return native;
    return docker;
  }

  /** The helper's own answer, or its last poll header, or a reason it is not there. */
  private async nativeStatus(): Promise<LayaStatus> {
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
    // Laya in Docker is built with the other images; there is nothing to install from here.
    if ((link === undefined || !link.isConnected()) && this.docker !== undefined) return this.docker.status();
    if (link === undefined || !link.isConnected()) {
      return {
        state: "unsupported",
        detail: "The host helper is not connected, so Laya cannot be installed.",
      };
    }
    return link.call("decisions.install", {}, STATUS_TIMEOUT_MS);
  }

  async unavailable(): Promise<string | undefined> {
    const native = this.nativeUnavailable();
    if (native === undefined || this.docker === undefined) return native;
    const docker = await this.docker.unavailable();
    return docker === undefined ? undefined : `${native}. ${docker}`;
  }

  private nativeUnavailable(): string | undefined {
    const link = this.host;
    if (link === undefined || !link.isConnected()) return "The host helper is not connected";
    // The poll header is at most 25 seconds old, which is fine for skipping.
    const laya = link.status().info?.laya;
    if (laya === undefined) return "This host helper is too old for Laya";
    if (laya.state === "ready" || laya.state === "loaded") return undefined;
    return laya.detail ?? `Laya is ${laya.state.replace("-", " ")}`;
  }

  async decide(request: DecideRequest) {
    if (this.nativeUnavailable() !== undefined && this.docker !== undefined)
      return this.docker.decide(request);
    const link = this.host;
    if (link === undefined) throw new Error("No host helper");
    const call = toLayaCall(request);
    // Fields go as text: Laya renders a dict as JSON anyway, and an older helper takes only text.
    const result = await link.call(
      "decide",
      { state: call.text, questions: call.questions },
      DECIDE_TIMEOUT_MS,
    );
    return { answers: fromLayaCall(request, result.answers), estimated: false, trimmed: call.trimmed };
  }
}
