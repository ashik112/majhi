import type { OwnerAnswer, OwnerAnswerTarget, WikiFactBasis, WikiFactOf } from "@majhi/shared";
import { outsideOfHost } from "../facts/known.ts";
import { endpointId } from "./address.ts";
import type { Resolver } from "./resolver.ts";

/**
 * Who owns an address a repo calls. Pure.
 *
 * A repo-to-repo line exists only when an address is proven to belong to another project: a compose file builds a
 * service of that name (basis declared), a compose or Kubernetes file defines the only service of that name (basis
 * config), or the owner said so (an answer, basis owner). A host name, a domain, a port or the words of a variable
 * never decide. An address nobody has placed stays an endpoint, and the page asks the owner about it.
 */

export type EndpointFact = WikiFactOf<"endpoint">;

/** Where an address leads: another project (and how that is known), a service outside the workspace, or nowhere worth showing. */
export type Placement =
  | { kind: "project"; project: string; basis: WikiFactBasis }
  | { kind: "outside" }
  | { kind: "ignore" };

/** The owner's answer for an address, if any. */
export function answerOf(
  answers: readonly OwnerAnswer[],
  e: Pick<EndpointFact, "host" | "port" | "scope">,
): OwnerAnswerTarget | undefined {
  const id = endpointId(e.host, e.port, e.scope);
  return answers.find((a) => endpointId(a.host, a.port, a.scope) === id)?.to;
}

/**
 * Where an address of `repo` leads. The files come first (a service one project builds, then one a project only
 * defines, then a third-party service the catalog knows), and the owner's answer settles what they could not.
 * `undefined`: nobody has placed it.
 */
export function placeAddress(
  resolver: Resolver,
  answers: readonly OwnerAnswer[],
  e: Pick<EndpointFact, "host" | "port" | "scope">,
  repo: string,
): Placement | undefined {
  const service = e.scope === undefined ? resolver.ownerOfService(e.host, repo) : undefined;
  if (service !== undefined) return { kind: "project", project: service.project, basis: service.basis };
  if (e.scope === undefined && outsideOfHost(e.host) !== undefined) return { kind: "outside" };
  const answer = answerOf(answers, e);
  if (answer === undefined) return undefined;
  return answer.kind === "project" ? { kind: "project", project: answer.project, basis: "owner" } : answer;
}
