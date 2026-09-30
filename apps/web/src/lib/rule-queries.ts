import type { AllowRule, CommandOutput, Settings } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

export type Allowances = CommandOutput<"permissions.list">;

/** The CLI "allow for this task" choices, across tasks. */
export function useAllowances() {
  return useQuery<Allowances, ApiRequestError>({
    queryKey: queryKeys.allowances,
    queryFn: () => cmd("permissions.list", {}),
  });
}

/** Forgets one CLI choice, so the CLI asks again for that task and kind. */
export function useRevokeAllowance() {
  const client = useQueryClient();
  return useMutation<Allowances, ApiRequestError, { task: string; kind: string }>({
    mutationFn: (input) => cmd("permissions.revoke", input, { reason: "Owner revoked a CLI permission" }),
    onSuccess: (list) => client.setQueryData(queryKeys.allowances, list),
  });
}

/** Removes one saved always-allow rule. The change is a config commit, so it shows in the history. */
export function useRemoveRule() {
  const client = useQueryClient();
  return useMutation<Settings, ApiRequestError, AllowRule>({
    mutationFn: (rule) => cmd("policy.removeRule", rule, { reason: "Owner removed an always-allow rule" }),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.settings, settings);
      return client.invalidateQueries({ queryKey: queryKeys.history });
    },
  });
}
