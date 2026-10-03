import type { CommandInput, CommandOutput, TrackerLink, TrackerStatus } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** Under `tasks`: a link changes with its task, and the tasks topic refetches it. */
const LINKS = [...queryKeys.tasks, "trackers"] as const;
/** Under `orgs`: a pull ends with an orgs event. */
const statusKey = (org: string) => [...queryKeys.orgs, "tracker", org] as const;

/** One task's link. Cards each read it, so it selects from the shared list instead of mapping it. */
export function useTrackerLink(task: string): TrackerLink | undefined {
  return useQuery<TrackerLink[], ApiRequestError, TrackerLink | undefined>({
    queryKey: LINKS,
    queryFn: () => cmd("trackers.links", {}),
    select: (links) => links.find((l) => l.task === task),
  }).data;
}

/** The org's last pull and the items that wait for a project. */
export function useTrackerStatus(org: string, enabled: boolean) {
  return useQuery<TrackerStatus, ApiRequestError>({
    queryKey: statusKey(org),
    queryFn: () => cmd("trackers.status", { org }),
    enabled,
  });
}

export function useTestTracker() {
  return useMutation<CommandOutput<"trackers.test">, ApiRequestError, string>({
    mutationFn: (org) => cmd("trackers.test", { org }),
  });
}

type ChangeCommand =
  | "trackers.pull"
  | "trackers.take"
  | "trackers.push"
  | "trackers.sync"
  | "trackers.unlink";

const REASON: Record<ChangeCommand, string> = {
  "trackers.pull": "Owner pulled the tracker",
  "trackers.take": "Owner took a tracker item",
  "trackers.push": "Owner pushed a task to the tracker",
  "trackers.sync": "Owner synced a task with its tracker item",
  "trackers.unlink": "Owner unlinked a task from its tracker item",
};

/** A trackers command that changes something. Links and the org's status refetch after it. */
export function useTrackerCommand<N extends ChangeCommand>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input, { reason: REASON[name] }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: LINKS }),
        client.invalidateQueries({ queryKey: [...queryKeys.orgs, "tracker"] }),
      ]),
  });
}
