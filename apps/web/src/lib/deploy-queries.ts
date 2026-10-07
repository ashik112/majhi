import type { CommandInput, CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * Where a project is deployed: its targets, what majhi found in the project, and the deploys so far.
 * Under the `projects` key, so a `projects` event (which a deploy emits at every step) reads it again.
 */
export const deployKey = (project: string) => [...queryKeys.projects, "deploy", project] as const;

export function useDeployView(project: string) {
  return useQuery<CommandOutput<"projects.deployView">, ApiRequestError>({
    queryKey: deployKey(project),
    queryFn: () => cmd("projects.deployView", { project }),
  });
}

/** One mutation of the deploy page, then the page and the tasks read again. */
function useDeployMutation<
  N extends "projects.setDeploy" | "projects.removeDeploy" | "projects.hideDeploySuggestion",
>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input),
    onSuccess: (view, input) => {
      client.setQueryData(deployKey(input.project), view);
      return client.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export const useSetDeploy = () => useDeployMutation("projects.setDeploy");
export const useRemoveDeploy = () => useDeployMutation("projects.removeDeploy");
export const useHideDeploySuggestion = () => useDeployMutation("projects.hideDeploySuggestion");

function useAfterDeploy() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.projects }),
      client.invalidateQueries({ queryKey: queryKeys.tasks }),
    ]);
}

/** Deploys the head of the base branch to one target. Answers at once; the run is followed on the server. */
export function useDeploy() {
  const after = useAfterDeploy();
  return useMutation<CommandOutput<"projects.deploy">, ApiRequestError, CommandInput<"projects.deploy">>({
    mutationFn: (input) => cmd("projects.deploy", input),
    onSuccess: after,
  });
}

export function useRollback() {
  const after = useAfterDeploy();
  return useMutation<CommandOutput<"projects.rollback">, ApiRequestError, CommandInput<"projects.rollback">>({
    mutationFn: (input) => cmd("projects.rollback", input),
    onSuccess: after,
  });
}

export function useHoldDeploy() {
  const after = useAfterDeploy();
  return useMutation<
    CommandOutput<"projects.holdDeploy">,
    ApiRequestError,
    CommandInput<"projects.holdDeploy">
  >({
    mutationFn: (input) => cmd("projects.holdDeploy", input),
    onSuccess: after,
  });
}
