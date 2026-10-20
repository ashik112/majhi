import { captainCannotRunId, type OwnerDecision } from "@majhi/shared";
import type { Lanes } from "./lanes.ts";

/**
 * A workspace whose captain has work and cannot run says so once, in Needs you, with the fix its typed reason
 * names. Derived from the lane's own check; it goes the moment the captain can run. Only the time it first
 * appeared is kept, so the card does not look new on every read.
 */
export class CannotRunDecisions {
  private readonly since = new Map<string, string>();

  constructor(
    private readonly lanes: Pick<Lanes, "cannotRun">,
    private readonly now: () => Date,
  ) {}

  async decisions(): Promise<OwnerDecision[]> {
    const rows = await this.lanes.cannotRun();
    const live = new Set(rows.map((r) => r.org));
    for (const org of this.since.keys()) if (!live.has(org)) this.since.delete(org);
    return rows.map(({ org, name, why, problem, until }) => {
      const at = this.since.get(org) ?? this.now().toISOString();
      this.since.set(org, at);
      const wait = why === "at-limit" && until !== undefined ? ` It resets at ${until}.` : "";
      return {
        id: captainCannotRunId(org),
        kind: "sign-in",
        org,
        title: "Captain cannot run",
        sentence: `The captain cannot run in ${name}: ${problem}.${wait}`,
        // Only one reason has a one-click fix: the workspace names an account that is not its own.
        options:
          why === "account-of-another-workspace"
            ? [{ id: "captain", label: "Use the captain's account", primary: true as const }]
            : [],
        at,
        link:
          why === "provider-not-allowed"
            ? { kind: "setup", section: "captain" }
            : { kind: "add-account", org },
      };
    });
  }
}
