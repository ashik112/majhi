import type { OwnerAnswer, OwnerAnswerTarget } from "@majhi/shared";

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
