import type { CommandInput, CommandOutput, Fact, FactStatus } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** Every fact the pages show fits in one page: 500 is the most `memory.list` gives. */
const ALL = 500;

/** Facts, newest first. Refetched on the `memory` event. */
export function useFacts(filter: { status?: FactStatus; task?: string } = {}, enabled = true) {
  return useQuery<Fact[], ApiRequestError>({
    queryKey: [...queryKeys.memory, "list", filter.status ?? "all", filter.task ?? "all"],
    queryFn: () => cmd("memory.list", { ...filter, limit: ALL }),
    enabled,
  });
}

/** How many facts wait for the owner: the number on the sidebar. */
export function usePendingFactCount(): number {
  return useFacts({ status: "pending" }).data?.length ?? 0;
}

/** Hybrid search over active facts. Idle while the query is empty. */
export function useMemorySearch(query: string) {
  const text = query.trim();
  return useQuery<CommandOutput<"memory.search">, ApiRequestError>({
    queryKey: [...queryKeys.memory, "search", text],
    queryFn: () => cmd("memory.search", { query: text, limit: 100 }),
    enabled: text !== "",
  });
}

/** The log, newest first: for one task, or all. */
export function useMemoryEvents(input: { task?: string; limit?: number } = {}) {
  const limit = input.limit ?? 50;
  return useQuery<CommandOutput<"memory.events">, ApiRequestError>({
    queryKey: [...queryKeys.memory, "events", input.task ?? "all", limit],
    queryFn: () => cmd("memory.events", { ...(input.task === undefined ? {} : { task: input.task }), limit }),
  });
}

function useMemoryMutation<
  N extends
    | "memory.approve"
    | "memory.reject"
    | "memory.forget"
    | "memory.pin"
    | "memory.undo"
    | "memory.extract"
    | "memory.promote",
>(name: N, reason: string) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input, { reason }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.memory });
      // A promotion or a read of the room makes tasks or room lines.
      if (name === "memory.promote" || name === "memory.extract") {
        await client.invalidateQueries({ queryKey: queryKeys.tasks });
      }
    },
  });
}

export const useApproveFact = () => useMemoryMutation("memory.approve", "Owner approved a fact");
export const useRejectFact = () => useMemoryMutation("memory.reject", "Owner rejected a fact");
export const useForgetFact = () => useMemoryMutation("memory.forget", "Owner forgot a fact");
export const usePinFact = () => useMemoryMutation("memory.pin", "Owner changed a fact's pin");
export const useUndoStep = () => useMemoryMutation("memory.undo", "Owner undid a memory step");
export const useExtractMemory = () =>
  useMemoryMutation("memory.extract", "Owner asked for the room to be read");
export const usePromoteFact = () => useMemoryMutation("memory.promote", "Owner added a fact to AGENTS.md");
