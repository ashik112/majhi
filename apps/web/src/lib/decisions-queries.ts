import type { CommandInput, CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

export type DecisionsStatus = CommandOutput<"decisions.status">;

/** Under `config`, so a config change (including Undo) refetches them. */
const keys = {
  status: [...queryKeys.config, "decisions"],
  recent: [...queryKeys.config, "decisions-recent"],
} as const;

/** Polls every 2 seconds while Laya installs or downloads its model. */
export function useDecisionsStatus() {
  return useQuery<DecisionsStatus, ApiRequestError>({
    queryKey: keys.status,
    queryFn: () => cmd("decisions.status", {}),
    refetchInterval: (query) => {
      const state = query.state.data?.laya.state;
      return state === "installing" || state === "downloading" ? 2_000 : false;
    },
  });
}

export function useRecentDecisions(limit = 5) {
  return useQuery<CommandOutput<"decisions.recent">, ApiRequestError>({
    queryKey: [...keys.recent, limit],
    queryFn: () => cmd("decisions.recent", { limit }),
  });
}

export function useSetDecisions() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"decisions.set">, ApiRequestError, CommandInput<"decisions.set">>({
    mutationFn: (input) => cmd("decisions.set", input, { reason: "Owner changed the decision provider" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.config }),
  });
}

/** Saves the Jev key as a secret, then points `decisions.jev_key` at it. The value is never kept. */
export function useSaveJevKey() {
  const client = useQueryClient();
  return useMutation<unknown, ApiRequestError, string>({
    mutationFn: async (value) => {
      const saved = await cmd("secrets.save", { name: "jev-key", value, label: "Jev API key" });
      return cmd("decisions.set", { jev_key: saved.ref }, { reason: "Owner set the Jev key" });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.config }),
  });
}

export function useInstallLaya() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"decisions.install">, ApiRequestError, void>({
    mutationFn: () => cmd("decisions.install", {}),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.status }),
  });
}

export function useAskDecision() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"decisions.ask">, ApiRequestError, CommandInput<"decisions.ask">>({
    mutationFn: (input) => cmd("decisions.ask", input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.recent }),
  });
}
