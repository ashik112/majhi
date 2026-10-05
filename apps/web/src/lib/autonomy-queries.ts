import type {
  AutonomyEvent,
  AutonomyReport,
  AutonomyStatus,
  CommandInput,
  CommandOutput,
  SlotCapacity,
} from "@majhi/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

const statusKey = [...queryKeys.autonomy, "status"] as const;
const detailKey = [...queryKeys.autonomy, "status", "detail"] as const;

/** True when the server has no autonomous mode to offer: the command is not built (501) or not there (404). */
export function autonomyMissing(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 501 || error.status === 404);
}

/**
 * `autonomy.status`. Without `detail` it is the small status every page reads; the Captain page asks for
 * the task lists, the backlog and the waiting cards too. The `autonomy` topic refetches it on every change; while the mode is not off
 * it is also read every 30 s, since spend moves with every turn and turns emit no `autonomy` event.
 */
export function useAutonomyStatus(detail = false) {
  return useQuery<AutonomyStatus, ApiRequestError>({
    queryKey: detail ? detailKey : statusKey,
    queryFn: () => cmd("autonomy.status", { detail }),
    retry: (count, error) => !autonomyMissing(error) && count < 2,
    refetchInterval: (query) => (query.state.data && query.state.data.mode !== "off" ? 30_000 : false),
    refetchIntervalInBackground: false,
  });
}

/** `autonomy.report`: the dashboard's charts. Read every minute while the page shows, since turns emit no event. */
export function useAutonomyReport(days = 14) {
  return useQuery<AutonomyReport, ApiRequestError>({
    queryKey: [...queryKeys.autonomy, "report", days],
    queryFn: () => cmd("autonomy.report", { days }),
    retry: (count, error) => !autonomyMissing(error) && count < 2,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/** `tasks.slots`: agent slots in use per account. Read every 15 s while a page shows it. */
export function useSlots() {
  return useQuery<SlotCapacity, ApiRequestError>({
    queryKey: [...queryKeys.tasks, "slots"],
    queryFn: () => cmd("tasks.slots", {}),
    retry: false,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

const PAGE = 50;

/** The feed, newest first; `decisions` keeps only decisions, approvals and refusals. Each page is older. */
export function useAutonomyEvents(decisions: boolean) {
  return useInfiniteQuery<
    { events: AutonomyEvent[] },
    ApiRequestError,
    { pages: { events: AutonomyEvent[] }[] },
    unknown[],
    number | undefined
  >({
    queryKey: [...queryKeys.autonomy, "events", decisions],
    queryFn: ({ pageParam }) =>
      cmd("autonomy.events", {
        limit: PAGE,
        decisions,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    initialPageParam: undefined,
    getNextPageParam: (last) => (last.events.length < PAGE ? undefined : last.events.at(-1)?.seq),
    retry: (count, error) => !autonomyMissing(error) && count < 2,
  });
}

type StatusCommand =
  | "autonomy.start"
  | "autonomy.pause"
  | "autonomy.stop"
  | "autonomy.configure"
  | "autonomy.forget"
  | "autonomy.exclude";

/**
 * A command that answers with the new status: it goes into the cache at once, and the feed refetches.
 * `reason` is the line the config history and the audit log keep.
 */
export function useAutonomyCommand<N extends StatusCommand>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, { input: CommandInput<N>; reason: string }>({
    mutationFn: ({ input, reason }) => cmd(name, input, { reason }),
    onSuccess: (status) => {
      client.setQueryData(statusKey, status);
      client.setQueryData(detailKey, status);
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.autonomy }),
        // A task's mark Not for autonomous mode shows on its card and in its header.
        ...(name === "autonomy.exclude" ? [client.invalidateQueries({ queryKey: queryKeys.tasks })] : []),
      ]);
    },
  });
}

/** The owner's message to the captain in its autonomy chat; `keep` also saves it as a standing instruction. */
export function useGuideAutonomy() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"autonomy.guide">, ApiRequestError, CommandInput<"autonomy.guide">>({
    mutationFn: (input) =>
      cmd("autonomy.guide", input, {
        reason: input.keep ? "Owner added a standing instruction" : "Owner wrote to the captain",
      }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.autonomy }),
        client.invalidateQueries({ queryKey: queryKeys.history }),
      ]),
  });
}
