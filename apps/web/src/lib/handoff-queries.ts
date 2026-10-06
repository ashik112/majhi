import type { CommandOutput, HandoffCommandStep } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** The checked hand-off of a task in review (SPEC 5.18). Under `tasks`, so a task change refetches it. */
export function useHandoff(task: string, enabled = true) {
  return useQuery<CommandOutput<"handoff.get">, ApiRequestError>({
    queryKey: [...queryKeys.tasks, "handoff", task],
    queryFn: () => cmd("handoff.get", { task }),
    enabled,
    // While a check runs the result lands without an event for it: look again soon.
    refetchInterval: (q) => (q.state.data?.running === true || q.state.data?.queued === true ? 2_000 : false),
    refetchIntervalInBackground: false,
  });
}

/** "Check again": runs the tests, build, lint and review of the task's head once more. */
export function useCheckAgain(task: string) {
  const client = useQueryClient();
  return useMutation<CommandOutput<"handoff.check">, ApiRequestError, void>({
    mutationFn: () =>
      cmd("handoff.check", { task, force: true }, { reason: "Owner asked for the check again" }),
    onSuccess: (state) => {
      client.setQueryData([...queryKeys.tasks, "handoff", task], state);
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.tasks }),
        client.invalidateQueries({ queryKey: queryKeys.decisions }),
      ]);
    },
  });
}

/** "Rerun": runs one step of the task's hand-off check again (the others stay as they were), through the same queue and limits. */
export function useRerunStep(task: string) {
  const client = useQueryClient();
  return useMutation<CommandOutput<"handoff.rerun">, ApiRequestError, HandoffCommandStep>({
    mutationFn: (step) => cmd("handoff.rerun", { task, step }, { reason: `Owner asked for ${step} again` }),
    onSuccess: (state) => {
      client.setQueryData([...queryKeys.tasks, "handoff", task], state);
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.tasks }),
        client.invalidateQueries({ queryKey: queryKeys.decisions }),
      ]);
    },
  });
}
