import type { CommandInput, CommandOutput, Settings, Task } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

export type HistoryEntries = CommandOutput<"history.list">;

/** The boss's chat task. The server creates it on first use, so this is safe to call any time. */
export function useBossChat(enabled = true) {
  return useQuery<Task, ApiRequestError>({
    // Under `agents`, so a new boss gives a new chat.
    queryKey: [...queryKeys.agents, "boss-chat"],
    queryFn: () => cmd("boss.chat", {}),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Archives the current boss chat and starts a new conversation. */
export function useNewBossChat() {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, void>({
    mutationFn: () => cmd("boss.chat", { fresh: true }),
    onSuccess: (task) => {
      client.setQueryData([...queryKeys.agents, "boss-chat"], task);
      void client.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useSettings() {
  return useQuery<Settings, ApiRequestError>({
    queryKey: queryKeys.settings,
    queryFn: () => cmd("settings.get", {}),
  });
}

export function useHistory(limit = 8) {
  return useQuery<HistoryEntries, ApiRequestError>({
    queryKey: [...queryKeys.history, limit],
    queryFn: () => cmd("history.list", { limit }),
  });
}

export function useUndo() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"history.undo">, ApiRequestError, string>({
    mutationFn: (commit) => cmd("history.undo", { commit }, { reason: "Owner undid a change" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.history }),
  });
}

export function useSaveSettings() {
  const client = useQueryClient();
  return useMutation<Settings, ApiRequestError, CommandInput<"settings.set">>({
    mutationFn: (input) => cmd("settings.set", input, { reason: "Owner changed settings" }),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.settings, settings);
      return client.invalidateQueries({ queryKey: queryKeys.history });
    },
  });
}

export function useSavePolicy() {
  const client = useQueryClient();
  return useMutation<Settings, ApiRequestError, CommandInput<"policy.set">>({
    mutationFn: (input) => cmd("policy.set", input, { reason: "Owner changed the approval policy" }),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.settings, settings);
      return client.invalidateQueries({ queryKey: queryKeys.history });
    },
  });
}
