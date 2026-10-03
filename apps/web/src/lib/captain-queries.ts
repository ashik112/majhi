import type { CaptainStatus, CommandInput, CommandOutput } from "@majhi/shared";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

const statusKey = [...queryKeys.captain, "status"] as const;

/**
 * `captain.status`: each workspace's choice, today's line and spend, its chores, and the stop
 * switch. The `captain` topic refetches it; spend moves with every turn, so it is also read each minute.
 */
export function useCaptainStatus() {
  return useQuery<CaptainStatus, ApiRequestError>({
    queryKey: statusKey,
    queryFn: () => cmd("captain.status", {}),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/** The captain's log, newest first, for one workspace or all. */
export function useCaptainLog(org: string | undefined) {
  return useQuery<CommandOutput<"captain.log">, ApiRequestError>({
    queryKey: [...queryKeys.captain, "log", org ?? "all"],
    queryFn: () => cmd("captain.log", { limit: 100, ...(org === undefined ? {} : { org }) }),
  });
}

type StatusCommand = "captain.stop" | "captain.resume" | "captain.choreOn";

/** Stop, resume, or turn a chore on again: the answer is the new status. */
export function useCaptainCommand<N extends StatusCommand>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, { input: CommandInput<N>; reason: string }>({
    mutationFn: ({ input, reason }) => cmd(name, input, { reason }),
    onSuccess: (status) => {
      client.setQueryData(statusKey, status);
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.autonomy }),
      ]);
    },
  });
}

const asksKey = [...queryKeys.captain, "asks"] as const;

/** `captain.asks`: the captain's questions about its daily caps today, for the bell and the Captain page. */
export function useCaptainAsks() {
  return useQuery<CommandOutput<"captain.asks">, ApiRequestError>({
    queryKey: asksKey,
    queryFn: () => cmd("captain.asks", {}),
  });
}

/** Raise a chore's daily cap for today, or leave it: the answer is what still waits. */
export function useAnswerCap() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"captain.answerCap">, ApiRequestError, CommandInput<"captain.answerCap">>({
    mutationFn: (input) =>
      cmd("captain.answerCap", input, {
        reason:
          input.answer === "raise"
            ? "Owner raised the captain's limit for today"
            : "Owner left the captain's limit as it is",
      }),
    onSuccess: (asks) => {
      client.setQueryData(asksKey, asks);
      return client.invalidateQueries({ queryKey: queryKeys.captain });
    },
  });
}

/** Raise a budget that ran out for today only, or leave it: the answer is what still waits. */
export function useAnswerBudget() {
  const client = useQueryClient();
  return useMutation<
    CommandOutput<"captain.answerBudget">,
    ApiRequestError,
    CommandInput<"captain.answerBudget">
  >({
    mutationFn: (input) =>
      cmd("captain.answerBudget", input, {
        reason:
          input.answer === "raise" ? "Owner raised a budget for today only" : "Owner left a budget as it is",
      }),
    onSuccess: (asks) => {
      client.setQueryData(asksKey, asks);
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.autonomy }),
        client.invalidateQueries({ queryKey: queryKeys.tasks }),
      ]);
    },
  });
}

/** Undo one action of the captain's log. */
export function useCaptainUndo() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"captain.undo">, ApiRequestError, { id: number }>({
    mutationFn: ({ id }) => cmd("captain.undo", { id }, { reason: "Owner undid the captain's action" }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.tasks }),
        client.invalidateQueries({ queryKey: queryKeys.config }),
      ]),
  });
}

/**
 * A workspace's choice, budget or "More rules", through `autonomy.configure`. The captain's status
 * and autonomous mode both read them.
 */
export function useCaptainRules() {
  const client = useQueryClient();
  return useMutation<
    CommandOutput<"autonomy.configure">,
    ApiRequestError,
    { input: CommandInput<"autonomy.configure">; reason: string }
  >({
    mutationFn: ({ input, reason }) => cmd("autonomy.configure", input, { reason }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.autonomy }),
      ]),
  });
}

/**
 * The newest items of each workspace thread, for the merged "All" view. The `captain` topic
 * refetches it, and it is read every 20 s while the view is open, since a room item has no event of
 * its own here.
 */
export function useThreadItems(threads: readonly { org: string; chat: string }[], enabled: boolean) {
  return useQueries({
    queries: threads.map((t) => ({
      queryKey: [...queryKeys.captain, "thread-items", t.chat],
      queryFn: () => cmd("room.items", { task: t.chat, limit: 30 }),
      enabled,
      refetchInterval: 20_000,
      refetchIntervalInBackground: false,
    })),
  });
}

/** "Start fresh" in a workspace's thread. */
export function useStartFresh() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"captain.startFresh">, ApiRequestError, { org: string; name: string }>({
    mutationFn: ({ org, name }) =>
      cmd("captain.startFresh", { org }, { reason: `Owner started fresh in the captain's ${name} thread` }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.captain }),
  });
}
