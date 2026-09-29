import type {
  CommandInput,
  CommandOutput,
  ConfigState,
  DirListing,
  HostStatus,
  ReposResponse,
  RootSuggestion,
  WorkspacesUpdate,
  WorkspacesUpdateResult,
} from "@majhi/shared";
import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ApiRequestError, cmd, getHealth } from "./api";

export const queryKeys = {
  config: ["config"],
  repos: ["repos"],
  health: ["health"],
  hostStatus: ["host-status"],
  suggestRoots: ["fs", "suggest-roots"],
  listDirs: ["fs", "list-dirs"],
  tools: ["tools"],
  orgs: ["orgs"],
  accounts: ["accounts"],
  accountModels: ["account-models"],
  agents: ["agents"],
  projects: ["projects"],
  tasks: ["tasks"],
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
    queryFn: ({ signal }) => getHealth(signal),
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

/** Whether the host helper is connected. Polled every 10 s, like the online pill. */
export function useHostStatus() {
  return useQuery<HostStatus, ApiRequestError>({
    queryKey: queryKeys.hostStatus,
    queryFn: () => cmd("host.status", {}),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Runs a command the host helper answers. A 503 `host-offline` also marks the helper as
 * disconnected, so the roots form falls back to typed paths without waiting for the next poll.
 */
async function hostCmd<N extends "fs.listDirs" | "fs.suggestRoots">(
  client: QueryClient,
  name: N,
  input: CommandInput<N>,
): Promise<CommandOutput<N>> {
  try {
    return await cmd(name, input);
  } catch (error) {
    if (error instanceof ApiRequestError && error.hostOffline) {
      // A status request already in flight would overwrite this with its older answer.
      await client.cancelQueries({ queryKey: queryKeys.hostStatus });
      client.setQueryData<HostStatus>(queryKeys.hostStatus, { connected: false });
    }
    throw error;
  }
}

/** Folders under home that hold git repos, with their repo counts. */
export function useSuggestRoots() {
  const client = useQueryClient();
  return useQuery<RootSuggestion[], ApiRequestError>({
    queryKey: queryKeys.suggestRoots,
    queryFn: async () => (await hostCmd(client, "fs.suggestRoots", {})).suggestions,
    staleTime: 60_000,
  });
}

/** Subfolders of `path` on the host. Keeps the previous listing on screen while the next one loads. */
export function useListDirs(path: string, showHidden: boolean) {
  const client = useQueryClient();
  return useQuery<DirListing, ApiRequestError>({
    queryKey: [...queryKeys.listDirs, path, showHidden],
    queryFn: () => hostCmd(client, "fs.listDirs", { path, showHidden }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/** Asks the host helper to mount every root in majhi.yaml, which restarts majhi. */
export function useRemount() {
  return useMutation<CommandOutput<"workspaces.remount">, ApiRequestError>({
    mutationFn: () => cmd("workspaces.remount", {}, { reason: "Owner asked to mount workspace roots" }),
  });
}

/** After majhi restarts, loads what the restart changed: the config, a fresh scan and the helper link. */
export async function reloadAfterRestart(client: QueryClient): Promise<void> {
  await Promise.all([
    client.fetchQuery({ queryKey: queryKeys.config, queryFn: () => cmd("config.get", {}) }),
    client.fetchQuery({ queryKey: queryKeys.repos, queryFn: () => cmd("repos.scan", { refresh: true }) }),
  ]);
  await client.invalidateQueries({ queryKey: queryKeys.hostStatus });
}
