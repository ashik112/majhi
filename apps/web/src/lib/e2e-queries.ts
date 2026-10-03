import type { CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";

export const e2eKeys = { status: ["e2e-status"] } as const;

/** The background e2e suite: the mode per project, the latest run per project, the run in progress and the queue. */
export function useE2eStatus() {
  return useQuery<CommandOutput<"e2e.status">, ApiRequestError>({
    queryKey: e2eKeys.status,
    queryFn: () => cmd("e2e.status", {}),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

/** Queues a run of a project's suite at its base branch's tip, whatever its mode. */
export function useE2eRunNow() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"e2e.runNow">, ApiRequestError, string>({
    mutationFn: (project) => cmd("e2e.runNow", { project }, { reason: "Owner pressed Run now" }),
    onSettled: () => client.invalidateQueries({ queryKey: e2eKeys.status }),
  });
}
