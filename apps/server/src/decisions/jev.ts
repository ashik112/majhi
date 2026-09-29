import type { DecideRequest } from "@majhi/shared";
import type { DecisionProvider, ProviderOutcome } from "./providers.ts";

/**
 * Jev is TypeSafe's hosted decision model. Its public docs describe the question types, but not the
 * base URL, the auth header or the response shape, so majhi does not send anything to it yet.
 * Plug a client in here once the API is confirmed; until then a key in `jev_key` only shows
 * "not verified" in the status.
 */
export interface JevClient {
  decide(request: DecideRequest, key: string): Promise<ProviderOutcome>;
}

export class JevProvider implements DecisionProvider {
  readonly id = "jev" as const;

  constructor(
    /** The `jev_key` secret's value, or undefined when none is set. */
    private readonly key: () => Promise<string | undefined>,
    private readonly client: JevClient | undefined = undefined,
  ) {}

  async unavailable(): Promise<string | undefined> {
    if ((await this.key()) === undefined) return "No Jev key is set";
    if (this.client === undefined) return "Jev's API is not verified in this version of majhi";
    return undefined;
  }

  async decide(request: DecideRequest): Promise<ProviderOutcome> {
    const key = await this.key();
    if (key === undefined || this.client === undefined) throw new Error("Jev is not configured");
    return this.client.decide(request, key);
  }
}
