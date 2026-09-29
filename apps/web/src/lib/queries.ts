import type { ConfigState, ReposResponse, WorkspacesUpdate, WorkspacesUpdateResult } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { type ApiRequestError, cmd, getHealth } from "./api";

export const queryKeys = {
  config: ["config"],
  repos: ["repos"],
  health: ["health"],
} as const;

export function useConfig() {
  return useQuery<ConfigState, ApiRequestError>({
    queryKey: queryKeys.config,
    queryFn: () => cmd("config.get", {}),
  });
}

/** Cached scan. The server keeps its own cache, so this is cheap; `useRescan` forces a fresh walk. */
export function useRepos(enabled: boolean) {
  return useQuery<ReposResponse, ApiRequestError>({
    queryKey: queryKeys.repos,
    queryFn: () => cmd("repos.scan", {}),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useRescan() {
  const client = useQueryClient();
  return useMutation<ReposResponse, ApiRequestError>({
    mutationFn: () => cmd("repos.scan", { refresh: true }),
    onSuccess: (data) => client.setQueryData(queryKeys.repos, data),
  });
}

/**
 * Saves the workspace roots. `onSaved` runs before the config cache changes, so a screen that
 * is about to be replaced (the first-run form) can still decide what comes next.
 */
export function useSetWorkspaces(onSaved?: (result: WorkspacesUpdateResult) => void) {
  const client = useQueryClient();
  return useMutation<WorkspacesUpdateResult, ApiRequestError, WorkspacesUpdate>({
    mutationFn: (input) => cmd("workspaces.set", input, { reason: "Owner edited workspace roots" }),
    onSuccess: async (result) => {
      onSaved?.(result);
      client.setQueryData(queryKeys.config, result.state);
      await client.invalidateQueries({ queryKey: queryKeys.repos });
    },
  });
}

/**
 * Polls `/health` every 10 s for the online pill. When the server comes back after being
 * unreachable (for example after `make up`), every other query is refetched.
 */
export function useHealth() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.health,
    queryFn: getHealth,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const online = query.isSuccess;
  const wasOffline = useRef(false);
  useEffect(() => {
    if (query.isError) wasOffline.current = true;
    if (online && wasOffline.current) {
      wasOffline.current = false;
      void client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== queryKeys.health[0] });
    }
  }, [online, query.isError, client]);

  return { ...query, online };
}
