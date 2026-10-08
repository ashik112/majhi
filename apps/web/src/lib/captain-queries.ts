import type { CaptainStatus, CommandInput, CommandOutput } from "@majhi/shared";
import { type QueryClient, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { type CaptainLog, LOG_LIMIT, mergeLog, replaceAction } from "./captain-log";
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

/**
 * The workspace's captain status while a message waits on it. The `captain` topic refetches it, and the server
 * emits that topic when a card for the owner appears or goes, so the reason it waits shows and goes without polling.
 */
export function useWaitingOn(org: string) {
  return useQuery<CaptainStatus, ApiRequestError>({
    queryKey: statusKey,
    queryFn: () => cmd("captain.status", {}),
    select: (status) => ({ ...status, orgs: status.orgs.filter((o) => o.org === org) }),
  });
}

/** Answers the permission card that keeps the captain waiting in a lane. */
export function useAnswerLaneCard() {
  const client = useQueryClient();
  return useMutation<unknown, ApiRequestError, { task: string; item: string; option: string }>({
    mutationFn: (input) => cmd("room.permission", input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.captain }),
  });
}

/** The wiki component names of a workspace, for the areas a ship rule covers. Rarely change, so kept for a minute. */
export function useAreaNames(org: string) {
  return useQuery<CommandOutput<"tasks.areaNames">, ApiRequestError>({
    queryKey: [...queryKeys.captain, "area-names", org],
    queryFn: () => cmd("tasks.areaNames", { org }),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Warms the Captain page: its code and `captain.status` (the sidebar already keeps `autonomy.status`), so opening it paints from the cache. Called when the
 * app is idle after the first paint and when the pointer reaches the Captain link or the chat button.
 * `captain.status` is not cheap on the server, so a read newer than `fresh` ms is left alone.
 */
export function prefetchCaptain(client: QueryClient, fresh = 30_000): void {
  void import("@/pages/captain-page");
  void client.prefetchQuery({
    queryKey: statusKey,
    queryFn: () => cmd("captain.status", {}),
    staleTime: fresh,
  });
}

/**
 * The captain's log, newest first, for one workspace or all. It is read in full once; every later
 * read asks only for the lines newer than the newest one held (`after`) and merges them in, and
 * reads the whole log again only when that read filled its page (a gap).
 */
export function useCaptainLog(org: string | undefined) {
  const client = useQueryClient();
  const key = [...queryKeys.captain, "log", org ?? "all"];
  return useQuery<CaptainLog, ApiRequestError>({
    queryKey: key,
    queryFn: async () => {
      const scope = org === undefined ? {} : { org };
      const held = client.getQueryData<CaptainLog>(key);
      const newest = held?.actions[0]?.id;
      if (held !== undefined && newest !== undefined) {
        const merged = mergeLog(
          held,
          await cmd("captain.log", { limit: LOG_LIMIT, after: newest, ...scope }),
        );
        if (merged !== null) return merged;
      }
      return cmd("captain.log", { limit: LOG_LIMIT, ...scope });
    },
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

/** `captain.asks`: the captain's questions about its budgets today, for the bell and the Limits page. */
export function useCaptainAsks() {
  return useQuery<CommandOutput<"captain.asks">, ApiRequestError>({
    queryKey: asksKey,
    queryFn: () => cmd("captain.asks", {}),
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
    onSuccess: (result) => {
      // The catch-up read only brings new lines, so the undone line is replaced here.
      client.setQueriesData<CaptainLog>({ queryKey: [...queryKeys.captain, "log"] }, (held) =>
        held === undefined ? held : replaceAction(held, result.action),
      );
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.tasks }),
        client.invalidateQueries({ queryKey: queryKeys.config }),
      ]);
    },
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
