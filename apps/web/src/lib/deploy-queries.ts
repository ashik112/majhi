import type { CommandInput, CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * Where a project is deployed: its environments and the deploys so far.
 * Under the `projects` key, so a `projects` event (which a deploy emits at every step) reads it again.
 */
export const deployKey = (project: string) => [...queryKeys.projects, "deploy", project] as const;

export function useDeployView(project: string) {
  return useQuery<CommandOutput<"projects.deployView">, ApiRequestError>({
    queryKey: deployKey(project),
    queryFn: () => cmd("projects.deployView", { project }),
  });
}

function useAfterDeploy() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.projects }),
      client.invalidateQueries({ queryKey: queryKeys.tasks }),
    ]);
}

/** Runs a planned, held or failed deploy by its record. Answers at once; the run is followed on the server. */
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

/** The whole list of a project's environments, written back (a tier change is one row of it). */
export function useSetEnvironments() {
  const after = useAfterDeploy();
  return useMutation<
    CommandOutput<"projects.setEnvironments">,
    ApiRequestError,
    CommandInput<"projects.setEnvironments">
  >({
    mutationFn: (input) => cmd("projects.setEnvironments", input),
    onSuccess: after,
  });
}
