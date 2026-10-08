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

/** Task records: search results by rank, or newest first when the query is empty. */
export function useTaskRecords(input: { query?: string; project?: string | undefined; limit?: number } = {}) {
  const query = input.query?.trim() ?? "";
  const limit = input.limit ?? 100;
  return useQuery<CommandOutput<"memory.records">, ApiRequestError>({
    queryKey: [...queryKeys.memory, "records", query, input.project ?? "all", limit],
    queryFn: () =>
      cmd("memory.records", {
        ...(query === "" ? {} : { query }),
        ...(input.project === undefined ? {} : { project: input.project }),
        limit,
      }),
  });
}

/** The record of one task, null before it is written. */
export function useTaskRecord(task: string) {
  return useQuery<CommandOutput<"memory.record">, ApiRequestError>({
    queryKey: [...queryKeys.memory, "record", task],
    queryFn: () => cmd("memory.record", { task }),
  });
}

/** A project's brief and every version of it. Idle without a project. */
export function useProjectBrief(project: string | undefined) {
  return useQuery<CommandOutput<"memory.brief">, ApiRequestError>({
    queryKey: [...queryKeys.memory, "brief", project ?? ""],
    queryFn: () => cmd("memory.brief", { project: project ?? "" }),
    enabled: project !== undefined,
  });
}

/** Threads by project, task or status. Without a status, open and closed ones both come back. */
export function useThreads(
  input: { project?: string | undefined; task?: string; status?: "open" | "closed" } = {},
) {
  return useQuery<CommandOutput<"memory.threads">, ApiRequestError>({
    queryKey: [
      ...queryKeys.memory,
      "threads",
      input.project ?? "all",
      input.task ?? "all",
      input.status ?? "any",
    ],
    queryFn: () =>
      cmd("memory.threads", {
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.task === undefined ? {} : { task: input.task }),
        ...(input.status === undefined ? {} : { status: input.status }),
        limit: 500,
      }),
  });
}

function useMemoryMutation<
  N extends
    | "memory.add"
    | "memory.approve"
    | "memory.edit"
    | "memory.reject"
    | "memory.forget"
    | "memory.pin"
    | "memory.undo"
    | "memory.extract"
    | "memory.promote"
    | "memory.approveAll"
    | "memory.rejectAll"
    | "memory.restoreBrief"
    | "memory.buildBrief"
    | "memory.closeThread"
    | "memory.reopenThread",
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

export const useAddFact = () => useMemoryMutation("memory.add", "Owner added a lesson");
export const useApproveFact = () => useMemoryMutation("memory.approve", "Owner approved a fact");
export const useEditFact = () => useMemoryMutation("memory.edit", "Owner edited a fact");
export const useRejectFact = () => useMemoryMutation("memory.reject", "Owner rejected a fact");
export const useForgetFact = () => useMemoryMutation("memory.forget", "Owner forgot a fact");
export const usePinFact = () => useMemoryMutation("memory.pin", "Owner changed a fact's pin");
export const useUndoStep = () => useMemoryMutation("memory.undo", "Owner undid a memory step");
export const useExtractMemory = () =>
  useMemoryMutation("memory.extract", "Owner asked for the room to be read");
export const usePromoteFact = () => useMemoryMutation("memory.promote", "Owner added a fact to AGENTS.md");
export const useApproveAllFacts = () =>
  useMemoryMutation("memory.approveAll", "Owner approved the pending lessons");
export const useRejectAllFacts = () =>
  useMemoryMutation("memory.rejectAll", "Owner rejected the pending lessons");
export const useRestoreBrief = () =>
  useMemoryMutation("memory.restoreBrief", "Owner restored a brief version");
export const useBuildBrief = () => useMemoryMutation("memory.buildBrief", "Owner asked for a project brief");
export const useCloseThread = () => useMemoryMutation("memory.closeThread", "Owner closed a thread");
export const useReopenThread = () => useMemoryMutation("memory.reopenThread", "Owner reopened a thread");
