import type { CommandOutput } from "@majhi/shared";
import { useQuery } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";

export const e2eKeys = { status: ["e2e-status"] } as const;

/** The background e2e suite: the latest run per project, the run in progress and the queue. */
export function useE2eStatus() {
  return useQuery<CommandOutput<"e2e.status">, ApiRequestError>({
    queryKey: e2eKeys.status,
    queryFn: () => cmd("e2e.status", {}),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
