import { type ConnectionView, connectionFailing, failureSentence, type OwnerDecision } from "@majhi/shared";

/**
 * A connection that fails and that agents rely on waits for the owner like any other decision: it counts in
 * Needs you and the bell, with the same rule as the Connections page and Health. One per connection.
 */
export function failingConnectionDecisions(views: readonly ConnectionView[]): OwnerDecision[] {
  const out: OwnerDecision[] = [];
  for (const view of views) {
    const health = view.health;
    if (health === undefined || !connectionFailing(health)) continue;
    if (health.state !== "failed" && health.state !== "needs-attention") continue;
    out.push({
      id: `connection:${view.id}`,
      kind: "sign-in",
      org: view.org,
      title: (health.state === "failed"
        ? `Fix ${view.name}: its agents cannot use it until you do`
        : `${view.name} needs one step from you`
      ).slice(0, 300),
      sentence:
        `${view.name} ${health.state === "failed" ? "is failing" : "needs attention"}. ${failureSentence(view)}`.slice(
          0,
          500,
        ),
      options: [],
      at: health.at,
      link: { kind: "connections" },
    });
  }
  return out;
}
