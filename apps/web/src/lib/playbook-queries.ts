import type { CommandInput, CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** Playbooks, goals and the outbound gate (SPEC 5.18). The `playbooks` topic refetches all of them. */

/** `playbooks.list`: every playbook of a workspace with its state, grouped on the page. */
export function usePlaybooks(org: string) {
  return useQuery<CommandOutput<"playbooks.list">, ApiRequestError>({
    queryKey: [...queryKeys.playbooks, "list", org],
    queryFn: () => cmd("playbooks.list", { org }),
    // Next runs move with the clock.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/** `playbooks.runs`: the history of one playbook in one workspace. */
export function usePlaybookRuns(org: string, id: string | undefined) {
  return useQuery<CommandOutput<"playbooks.runs">, ApiRequestError>({
    queryKey: [...queryKeys.playbooks, "runs", org, id ?? ""],
    queryFn: () => cmd("playbooks.runs", { org, id: id ?? "", limit: 20 }),
    enabled: id !== undefined,
  });
}

function useRefetchPlaybooks() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.playbooks }),
      client.invalidateQueries({ queryKey: queryKeys.captain }),
      client.invalidateQueries({ queryKey: queryKeys.decisions }),
    ]);
}

export function useUpdatePlaybook() {
  const done = useRefetchPlaybooks();
  return useMutation<CommandOutput<"playbooks.update">, ApiRequestError, CommandInput<"playbooks.update">>({
    mutationFn: (input) => cmd("playbooks.update", input, { reason: "Owner changed a playbook" }),
    onSuccess: done,
  });
}

export function useRunPlaybook() {
  const done = useRefetchPlaybooks();
  return useMutation<CommandOutput<"playbooks.run">, ApiRequestError, CommandInput<"playbooks.run">>({
    mutationFn: (input) => cmd("playbooks.run", input, { reason: "Owner ran a playbook now" }),
    onSuccess: done,
  });
}

/** `goals.list`: every goal, for the Goals section. */
export function useGoals() {
  return useQuery<CommandOutput<"goals.list">, ApiRequestError>({
    queryKey: [...queryKeys.playbooks, "goals"],
    queryFn: () => cmd("goals.list", {}),
  });
}

export function useCreateGoal() {
  const done = useRefetchPlaybooks();
  return useMutation<CommandOutput<"goals.create">, ApiRequestError, CommandInput<"goals.create">>({
    mutationFn: (input) => cmd("goals.create", input, { reason: "Owner added a goal" }),
    onSuccess: done,
  });
}

export function useUpdateGoal() {
  const done = useRefetchPlaybooks();
  return useMutation<CommandOutput<"goals.update">, ApiRequestError, CommandInput<"goals.update">>({
    mutationFn: (input) => cmd("goals.update", input, { reason: "Owner changed a goal" }),
    onSuccess: done,
  });
}

export function useRemoveGoal() {
  const done = useRefetchPlaybooks();
  return useMutation<CommandOutput<"goals.remove">, ApiRequestError, CommandInput<"goals.remove">>({
    mutationFn: (input) => cmd("goals.remove", input, { reason: "Owner removed a goal" }),
    onSuccess: done,
  });
}

/** `outbound.list`: each channel's mode in a workspace and its drafts. */
export function useOutbound(org: string) {
  return useQuery<CommandOutput<"outbound.list">, ApiRequestError>({
    queryKey: [...queryKeys.playbooks, "outbound", org],
    queryFn: () => cmd("outbound.list", { org }),
  });
}

export function useSetChannelMode() {
  const done = useRefetchPlaybooks();
  return useMutation<CommandOutput<"outbound.setMode">, ApiRequestError, CommandInput<"outbound.setMode">>({
    mutationFn: (input) => cmd("outbound.setMode", input, { reason: "Owner set how a channel sends" }),
    onSuccess: done,
  });
}
