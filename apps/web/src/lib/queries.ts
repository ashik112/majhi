import type {
  CommandInput,
  CommandOutput,
  ConfigState,
  DirListing,
  HostStatus,
  ReposResponse,
  RootSuggestion,
  SshStatus,
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
  /** Under `config`, so a config change refetches them too. */
  settings: ["config", "settings"],
  history: ["config", "history"],
  secrets: ["secrets"],
  /** The CLI "allow for this task" choices. */
  allowances: ["allowances"],
  /** Every `usage.*` read: totals, breakdowns, turns and the price table. */
  usage: ["usage"],
  /** `budgets.status`. Under `usage`, so every recorded turn refetches it too. */
  budgets: ["usage", "budgets"],
  /** Every `memory.*` read: facts, search and the log. */
  memory: ["memory"],
  /** Every `containers.*` read: running previews and services across tasks. */
  containers: ["containers"],
  /** Every `schedules.*` read: the list, one schedule and its runs. */
  schedules: ["schedules"],
  /** Every `triggers.*` read: the list, one trigger and its runs. */
  triggers: ["triggers"],
  /** Every `connections.*` read: the list, one connection and the types. */
  connections: ["connections"],
  /** Every `skills.*` read: the installed list and directory searches. */
  skills: ["skills"],
  /** Every `autonomy.*` read: the status and the feed. */
  autonomy: ["autonomy"],
  /** Every `captain.*` read: the status per workspace and the log. */
  captain: ["captain"],
  /** `decisions.list`: the owner's inbox. Every topic that changes what waits for them refetches it. */
  decisions: ["decisions"],
  /** `git.signIn.poll` for each flow. */
  signins: ["signins"],
  /** `projects.cloneStatus`. */
  clones: ["clones"],
  /** `onboarding.status`. Under `config`; the accounts, agents, orgs, projects, signins and clones topics refetch it too. */
  onboarding: ["config", "onboarding"],
  /** `git.remoteRepos` and `git.remoteOwners`. Under `orgs`, so a new sign-in refetches them. */
  remoteRepos: ["orgs", "remote-repos"],
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
    mutationFn: (input) => cmd("workspaces.set", input, { reason: "Owner edited project folders" }),
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

/** Puts the SSH status a command returned into the host status the Repos screen reads. */
function noteSsh(client: QueryClient, ssh: SshStatus): void {
  client.setQueryData<HostStatus>(queryKeys.hostStatus, (old) =>
    old?.info === undefined ? old : { ...old, info: { ...old.info, ssh } },
  );
}

/** Asks the host helper to load this computer's SSH keys again. */
export function useSshReload() {
  const client = useQueryClient();
  return useMutation<SshStatus, ApiRequestError>({
    mutationFn: () => cmd("ssh.reload", {}, { reason: "Owner asked to check SSH keys again" }),
    onSuccess: (ssh) => noteSsh(client, ssh),
  });
}

/**
 * Gives one key its passphrase. The passphrase lives only in this call: the mutation is not
 * kept after it settles (`gcTime: 0`), and no reason or log line carries it.
 */
export function useSshUnlock() {
  const client = useQueryClient();
  return useMutation<SshStatus, ApiRequestError, { key: string; passphrase: string }>({
    mutationFn: (input) => cmd("ssh.unlock", input, { reason: "Owner unlocked an SSH key" }),
    onSuccess: (ssh) => noteSsh(client, ssh),
    gcTime: 0,
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
    mutationFn: () => cmd("workspaces.remount", {}, { reason: "Owner asked to mount project folders" }),
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
