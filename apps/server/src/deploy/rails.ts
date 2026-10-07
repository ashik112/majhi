import type { DeployEnvironment } from "@majhi/shared";

/**
 * What the captain may change in a project's environments. The owner may do anything; the captain adds
 * environments (always production) and sets their branch and check, and nothing that lowers who decides a
 * deploy: it never sets a tier to staging and never removes a production environment. Pure, so the command
 * and its test read one answer. A sentence when the change is refused, else undefined.
 */
export function environmentsProblem(
  current: readonly DeployEnvironment[],
  next: readonly DeployEnvironment[],
  actor: "owner" | "captain",
): string | undefined {
  if (actor === "owner") return undefined;
  const before = new Map(current.map((e) => [e.env, e]));
  for (const env of next) {
    if (env.tier === "staging" && before.get(env.env)?.tier !== "staging") {
      return `Only the owner sets ${env.env} to staging: a staging environment is deployed under the Deploy staging rule. Add it as production and the owner can change its tier.`;
    }
  }
  const kept = new Set(next.map((e) => e.env));
  const dropped = current.find((e) => e.tier === "production" && !kept.has(e.env));
  if (dropped !== undefined) return `Only the owner removes a production environment (${dropped.env}).`;
  return undefined;
}
