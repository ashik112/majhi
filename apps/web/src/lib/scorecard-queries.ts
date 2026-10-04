import type { CommandInput, CommandOutput, EconomicsRange, ScorecardRange } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** The scorecard, the trust ladder and the monthly ceiling (SPEC 5.18). The `captain` topic refetches them. */

export function useScorecard(range: ScorecardRange, enabled = true) {
  return useQuery<CommandOutput<"scorecard.get">, ApiRequestError>({
    queryKey: [...queryKeys.captain, "scorecard", range],
    queryFn: () => cmd("scorecard.get", { range }),
    enabled,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });
}

export function useMoney() {
  return useQuery<CommandOutput<"money.get">, ApiRequestError>({
    queryKey: [...queryKeys.captain, "money"],
    queryFn: () => cmd("money.get", {}),
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });
}

/** Per workspace economics, this week or month against the one before. The `captain` topic refetches it. */
export function useEconomics(range: EconomicsRange) {
  return useQuery<CommandOutput<"economics.get">, ApiRequestError>({
    queryKey: [...queryKeys.captain, "economics", range],
    queryFn: () => cmd("economics.get", { range }),
    refetchInterval: 300_000,
    refetchIntervalInBackground: false,
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.captain }),
      client.invalidateQueries({ queryKey: queryKeys.decisions }),
      client.invalidateQueries({ queryKey: queryKeys.playbooks }),
    ]);
}

export function useSetMoney() {
  const done = useRefresh();
  return useMutation<CommandOutput<"money.set">, ApiRequestError, CommandInput<"money.set">>({
    mutationFn: (input) => cmd("money.set", input, { reason: "Owner changed the monthly ceiling or a rate" }),
    onSuccess: done,
  });
}

export function useSetMinutes() {
  const done = useRefresh();
  return useMutation<
    CommandOutput<"scorecard.setMinutes">,
    ApiRequestError,
    CommandInput<"scorecard.setMinutes">
  >({
    mutationFn: (input) =>
      cmd("scorecard.setMinutes", input, { reason: "Owner changed the minutes an action saves" }),
    onSuccess: done,
  });
}

export function useUnmute() {
  const done = useRefresh();
  return useMutation<CommandOutput<"trust.unmute">, ApiRequestError, CommandInput<"trust.unmute">>({
    mutationFn: (input) => cmd("trust.unmute", input, { reason: "Owner undid a mute" }),
    onSuccess: done,
  });
}
