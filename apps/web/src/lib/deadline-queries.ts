import type { CommandInput, CommandName, CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** The `business` topic refetches these. The list is fetched whole and filtered on the page. */
const KEY = queryKeys.business;

export function useDeadlines() {
  return useQuery<CommandOutput<"deadlines.list">, ApiRequestError>({
    queryKey: [...KEY, "deadlines.list"],
    queryFn: () => cmd("deadlines.list", { status: "all", limit: 2000 }),
  });
}

/** A deadline command as the owner; the page refetches through the `business` topic and here too. */
export function useDeadlineCommand<N extends CommandName>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}
