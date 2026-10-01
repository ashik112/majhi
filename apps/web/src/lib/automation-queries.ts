import type { AutomationRun, CommandInput, CommandOutput, ScheduleView, TriggerView } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** Schedules, oldest first, optionally for one org. Refetched on the `schedules` event. */
export function useSchedules(org: string | undefined) {
  return useQuery<ScheduleView[], ApiRequestError>({
    queryKey: [...queryKeys.schedules, "list", org ?? "all"],
    queryFn: () => cmd("schedules.list", org === undefined ? {} : { org }),
  });
}

/** The runs of one schedule, newest first. Idle without an id. */
export function useScheduleRuns(id: string | undefined) {
  return useQuery<AutomationRun[], ApiRequestError>({
    queryKey: [...queryKeys.schedules, "runs", id ?? ""],
    queryFn: () => cmd("schedules.runs", { id: id ?? "", limit: 50 }),
    enabled: id !== undefined,
  });
}

export function useTriggers(org: string | undefined) {
  return useQuery<TriggerView[], ApiRequestError>({
    queryKey: [...queryKeys.triggers, "list", org ?? "all"],
    queryFn: () => cmd("triggers.list", org === undefined ? {} : { org }),
  });
}

export function useTriggerRuns(id: string | undefined) {
  return useQuery<AutomationRun[], ApiRequestError>({
    queryKey: [...queryKeys.triggers, "runs", id ?? ""],
    queryFn: () => cmd("triggers.runs", { id: id ?? "", limit: 50 }),
    enabled: id !== undefined,
  });
}

type ScheduleCommand =
  | "schedules.create"
  | "schedules.update"
  | "schedules.pause"
  | "schedules.resume"
  | "schedules.runNow"
  | "schedules.delete";
type TriggerCommand =
  | "triggers.create"
  | "triggers.update"
  | "triggers.pause"
  | "triggers.resume"
  | "triggers.runNow"
  | "triggers.delete";

/** One mutation per command; the lists and histories refetch when it succeeds. */
export function useAutomationCommand<N extends ScheduleCommand | TriggerCommand>(name: N) {
  const client = useQueryClient();
  const key = name.startsWith("schedules.") ? queryKeys.schedules : queryKeys.triggers;
  return useMutation<CommandOutput<N>, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
}
