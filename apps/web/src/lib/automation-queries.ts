import type { AutomationRun } from "@majhi/shared";
import { useQuery } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** The runs of one clock playbook (its id is the schedule id), newest first. Idle without an id. */
export function useScheduleRuns(id: string | undefined) {
  return useQuery<AutomationRun[], ApiRequestError>({
    queryKey: [...queryKeys.schedules, "runs", id ?? ""],
    queryFn: () => cmd("schedules.runs", { id: id ?? "", limit: 50 }),
    enabled: id !== undefined,
  });
}
