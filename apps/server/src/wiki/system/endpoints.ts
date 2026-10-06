import type { OwnerAnswer, OwnerAnswerTarget, WikiFactOf } from "@majhi/shared";
import { endpointId } from "./address.ts";

/**
 * Who owns an address a repo calls. Pure.
 *
 * A repo-to-repo line exists only when an address is proven to belong to another project: a compose file builds
 * a service of that name (`known`, basis declared), or the owner said so (an answer, basis owner). A host name,
 * a domain, a port or the words of a variable never decide. An address nobody has an answer for stays an
 * endpoint, and the page asks the owner about it.
 */

export type EndpointFact = WikiFactOf<"endpoint">;

/** The owner's answer for an address, if any. */
export function answerOf(
  answers: readonly OwnerAnswer[],
  e: Pick<EndpointFact, "host" | "port" | "scope">,
): OwnerAnswerTarget | undefined {
  const id = endpointId(e.host, e.port, e.scope);
  return answers.find((a) => endpointId(a.host, a.port, a.scope) === id)?.to;
}

/** The project that owns an address, and how that is known. */
export function ownerOf(
  answers: readonly OwnerAnswer[],
  e: EndpointFact,
): { project: string; basis: "declared" | "owner" } | undefined {
  if (e.known !== undefined) return { project: e.known, basis: "declared" };
  const answer = answerOf(answers, e);
  return answer?.kind === "project" ? { project: answer.project, basis: "owner" } : undefined;
}

/** Addresses nobody has said anything about, most called first. */
export function unanswered(input: {
  endpoints: readonly EndpointFact[];
  answers: readonly OwnerAnswer[];
}): EndpointFact[] {
  return input.endpoints
    .filter((e) => e.known === undefined && answerOf(input.answers, e) === undefined)
    .toSorted((a, b) => b.sources.length - a.sources.length || a.id.localeCompare(b.id));
}
