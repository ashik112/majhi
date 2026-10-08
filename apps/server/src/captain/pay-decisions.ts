import { captainPayDecisionId, type OwnerDecision } from "@majhi/shared";
import type { Lanes } from "./lanes.ts";

/**
 * A workspace whose captain has no account it may use asks the owner once, in Needs you: which of their Private
 * accounts may pay, or add one of the workspace's own. Derived from the lane's own check; it goes the moment an
 * account may pay. Only the time it first appeared is kept, so the card does not look new on every read.
 */
export class PayDecisions {
  private readonly since = new Map<string, string>();

  constructor(
    private readonly lanes: Pick<Lanes, "unpaid">,
    private readonly now: () => Date,
  ) {}

  async decisions(): Promise<OwnerDecision[]> {
    const unpaid = await this.lanes.unpaid();
    const live = new Set(unpaid.map((u) => u.org));
    for (const org of this.since.keys()) if (!live.has(org)) this.since.delete(org);
    return unpaid.map(({ org, name, choices }) => {
      const at = this.since.get(org) ?? this.now().toISOString();
      this.since.set(org, at);
      return {
        id: captainPayDecisionId(org),
        kind: "sign-in",
        org,
        title: "Captain blocked: no account",
        sentence: `${name} has work for the captain and no account to run it on. Pick one of your accounts to pay for it.`,
        options: choices.map((id, i) => ({
          id,
          label: `Pick ${id}`,
          ...(i === 0 ? { primary: true as const } : {}),
        })),
        at,
        link: { kind: "add-account", org },
      };
    });
  }
}
