import type { BudgetStatus, Settings } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** Each budgeted org and account: used this week, percent and alerts fired. */
export function useBudgetStatus() {
  return useQuery<BudgetStatus, ApiRequestError>({
    queryKey: queryKeys.budgets,
    queryFn: () => cmd("budgets.status", {}),
  });
}

export interface BudgetChange {
  scope: "org" | "account";
  id: string;
  /** `null` removes the budget. */
  budget: { tokens?: number; cost?: number } | null;
}

/** Sets or removes one budget through `settings.set`. It applies at once. */
export function useSetBudget() {
  const client = useQueryClient();
  return useMutation<Settings, ApiRequestError, BudgetChange>({
    mutationFn: ({ scope, id, budget }) =>
      cmd(
        "settings.set",
        { budgets: { [scope === "org" ? "orgs" : "accounts"]: { [id]: budget } } },
        {
          reason:
            budget === null
              ? `Owner removed the weekly budget of ${scope} ${id}`
              : `Owner set the weekly budget of ${scope} ${id}`,
        },
      ),
    onSuccess: async (settings) => {
      client.setQueryData(queryKeys.settings, settings);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.budgets }),
        client.invalidateQueries({ queryKey: queryKeys.history }),
      ]);
    },
  });
}
