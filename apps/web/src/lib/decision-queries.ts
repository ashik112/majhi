import type { DecisionAnswerInput, DecisionList } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * `decisions.list`: everything that waits for the owner, ship and budget first, then oldest first.
 * The tasks, captain, autonomy and accounts topics refetch it.
 */
export function useDecisions() {
  return useQuery<DecisionList, ApiRequestError>({
    queryKey: queryKeys.decisions,
    queryFn: () => cmd("decisions.list", {}),
  });
}

/** Answer one decision with one of its options. The answer is what still waits. */
export function useAnswerDecision() {
  const client = useQueryClient();
  return useMutation<DecisionList, ApiRequestError, DecisionAnswerInput>({
    mutationFn: (input) => cmd("decisions.answer", input, { reason: "Owner answered a decision" }),
    onSuccess: (left) => {
      client.setQueryData(queryKeys.decisions, left);
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.tasks }),
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.autonomy }),
      ]);
    },
  });
}
