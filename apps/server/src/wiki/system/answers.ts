import type {
  OwnerAnswer,
  OwnerAnswerTarget,
  OwnerCallAnswer,
  OwnerRoleAnswer,
  RoleChoice,
  WikiKnownRole,
} from "@majhi/shared";

/**
 * Records what the owner says an address is, or forgets the answer when `to` is missing. A later answer for the
 * same address replaces the earlier one. Every later update applies the stored answers again.
 */
export function answerAddress(
  answers: readonly OwnerAnswer[],
  address: { host: string; port: number | undefined; scope: string | undefined },
  to: OwnerAnswerTarget | undefined,
): OwnerAnswer[] {
  const same = (a: OwnerAnswer) =>
    a.host === address.host && a.port === address.port && a.scope === address.scope;
  return [
    ...answers.filter((a) => !same(a)),
    ...(to === undefined
      ? []
      : [
          {
            host: address.host,
            ...(address.port === undefined ? {} : { port: address.port }),
            ...(address.scope === undefined ? {} : { scope: address.scope }),
            to,
          },
        ]),
  ];
}

/** Records what the owner says one call is, or forgets the answer when `to` is missing. Same shape as `answerAddress`. */
export function answerCall(
  answers: readonly OwnerCallAnswer[],
  call: Pick<OwnerCallAnswer, "repo" | "method" | "path">,
  to: OwnerAnswerTarget | undefined,
): OwnerCallAnswer[] {
  const same = (a: OwnerCallAnswer) =>
    a.repo === call.repo && a.method === call.method && a.path === call.path;
  return [
    ...answers.filter((a) => !same(a)),
    ...(to === undefined ? [] : [{ repo: call.repo, method: call.method, path: call.path, to }]),
  ];
}

/**
 * Records the owner's decision about a role tile, or removes it when `choice` is missing. The tile is named by what
 * the owner sees: after a change the tile shows the new role, so a choice already made for this place whose
 * writer's role or chosen role is `shown` is the one that is replaced, and the key stays the writer's.
 */
export function answerRole(
  answers: readonly OwnerRoleAnswer[],
  tile: { project: string; role: WikiKnownRole; where: string },
  choice: RoleChoice | undefined,
): OwnerRoleAnswer[] {
  const here = (a: OwnerRoleAnswer) => a.project === tile.project && a.where === tile.where;
  const own = answers.find((a) => here(a) && (a.role === tile.role || a.choice === tile.role));
  const role = own?.role ?? tile.role;
  return [
    ...answers.filter((a) => a !== own),
    ...(choice === undefined ? [] : [{ project: tile.project, role, where: tile.where, choice }]),
  ];
}
