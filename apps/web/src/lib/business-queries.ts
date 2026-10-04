import type { CommandInput, CommandName, CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** The `business` topic refetches every one of these. Lists are fetched whole and filtered on the page. */
const KEY = queryKeys.business;

export function useKbList(removed = false) {
  return useQuery<CommandOutput<"kb.list">, ApiRequestError>({
    queryKey: [...KEY, "kb.list", removed],
    queryFn: () => cmd("kb.list", { limit: 2000, ...(removed ? { removed: true } : {}) }),
  });
}

export function useKbEntry(id: number | undefined, version?: number) {
  return useQuery<CommandOutput<"kb.get">, ApiRequestError>({
    queryKey: [...KEY, "kb.get", id, version],
    queryFn: () => cmd("kb.get", { id: id as number, ...(version === undefined ? {} : { version }) }),
    enabled: id !== undefined,
  });
}

export function useCrmList() {
  return useQuery<CommandOutput<"crm.list">, ApiRequestError>({
    queryKey: [...KEY, "crm.list"],
    queryFn: () => cmd("crm.list", { limit: 5000 }),
  });
}

export function useCrmContact(id: number | undefined) {
  return useQuery<CommandOutput<"crm.get">, ApiRequestError>({
    queryKey: [...KEY, "crm.get", id],
    queryFn: () => cmd("crm.get", { id: id as number }),
    enabled: id !== undefined,
  });
}

export function useDeadlines() {
  return useQuery<CommandOutput<"deadlines.list">, ApiRequestError>({
    queryKey: [...KEY, "deadlines.list"],
    queryFn: () => cmd("deadlines.list", { status: "all", limit: 2000 }),
  });
}

export function useVoice(org: string | undefined) {
  return useQuery<CommandOutput<"voice.get">, ApiRequestError>({
    queryKey: [...KEY, "voice.get", org ?? ""],
    queryFn: () => cmd("voice.get", org === undefined ? {} : { org }),
  });
}

/** Any business command as the owner; the page refetches through the `business` topic and here too. */
export function useBusinessCommand<N extends CommandName>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}
