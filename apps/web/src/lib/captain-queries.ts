import type { CaptainStatus, CommandInput, CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

const statusKey = [...queryKeys.captain, "status"] as const;

/**
 * `captain.status`: each workspace's choice, today's line and spend, its chores, and the stop
 * switch. The `captain` topic refetches it; spend moves with every turn, so it is also read each minute.
 */
export function useCaptainStatus() {
  return useQuery<CaptainStatus, ApiRequestError>({
    queryKey: statusKey,
    queryFn: () => cmd("captain.status", {}),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/** The captain's log, newest first, for one workspace or all. */
export function useCaptainLog(org: string | undefined) {
  return useQuery<CommandOutput<"captain.log">, ApiRequestError>({
    queryKey: [...queryKeys.captain, "log", org ?? "all"],
    queryFn: () => cmd("captain.log", { limit: 100, ...(org === undefined ? {} : { org }) }),
  });
}

type StatusCommand = "captain.stop" | "captain.resume" | "captain.choreOn";

/** Stop, resume, or turn a chore on again: the answer is the new status. */
export function useCaptainCommand<N extends StatusCommand>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, { input: CommandInput<N>; reason: string }>({
    mutationFn: ({ input, reason }) => cmd(name, input, { reason }),
    onSuccess: (status) => {
      client.setQueryData(statusKey, status);
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.autonomy }),
      ]);
    },
  });
}

/** Undo one action of the captain's log. */
export function useCaptainUndo() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"captain.undo">, ApiRequestError, { id: number }>({
    mutationFn: ({ id }) => cmd("captain.undo", { id }, { reason: "Owner undid the captain's action" }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.tasks }),
        client.invalidateQueries({ queryKey: queryKeys.config }),
      ]),
  });
}

/**
 * A workspace's choice, budget or "More rules", through `autonomy.configure`. The captain's status
 * and autonomous mode both read them.
 */
export function useCaptainRules() {
  const client = useQueryClient();
  return useMutation<
    CommandOutput<"autonomy.configure">,
    ApiRequestError,
    { input: CommandInput<"autonomy.configure">; reason: string }
  >({
    mutationFn: ({ input, reason }) => cmd("autonomy.configure", input, { reason }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.autonomy }),
      ]),
  });
}
