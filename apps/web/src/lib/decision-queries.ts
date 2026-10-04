import type {
  DecisionAnswerInput,
  DecisionBatchInput,
  DecisionBatchResult,
  DecisionDetail,
  DecisionList,
} from "@majhi/shared";
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

/**
 * `decisions.detail`: the hand-back, diff stat, checks and target of the selected decision. Kept under
 * the list's key, so the same topics refetch it. A decision that is gone answers 404 and is not retried.
 */
export function useDecisionDetail(id: string | undefined) {
  return useQuery<DecisionDetail, ApiRequestError>({
    queryKey: [...queryKeys.decisions, "detail", id],
    queryFn: () => cmd("decisions.detail", { id: id ?? "" }),
    enabled: id !== undefined,
    retry: false,
  });
}

const ANSWERED_KEY = "majhi.decisions.answeredAt";

/** When the owner last answered a decision in this browser, for the empty state. */
export function lastAnsweredAt(): string | undefined {
  try {
    return localStorage.getItem(ANSWERED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberAnswer(): void {
  try {
    localStorage.setItem(ANSWERED_KEY, new Date().toISOString());
  } catch {
    // Storage can be blocked; the empty state then says nothing about the last answer.
  }
}

/** Answer one decision with one of its options. The answer is what still waits. */
export function useAnswerDecision() {
  const client = useQueryClient();
  return useMutation<DecisionList, ApiRequestError, DecisionAnswerInput>({
    mutationFn: (input) => cmd("decisions.answer", input, { reason: "Owner answered a decision" }),
    onSuccess: (left) => {
      rememberAnswer();
      client.setQueryData(queryKeys.decisions, left);
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.tasks }),
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.autonomy }),
      ]);
    },
  });
}

/** What still waits after a batch: the list, and the other places that count decisions. */
export function useAfterBatch() {
  const client = useQueryClient();
  return (result: DecisionBatchResult) => {
    if (result.done.length > 0) rememberAnswer();
    client.setQueryData(queryKeys.decisions, { decisions: result.decisions });
    return Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.tasks }),
      client.invalidateQueries({ queryKey: queryKeys.captain }),
      client.invalidateQueries({ queryKey: queryKeys.autonomy }),
    ]);
  };
}

/** Approve or leave many decisions at once. Each is taken on its own; the result lists what was not. */
export function useAnswerBatch() {
  const after = useAfterBatch();
  return useMutation<DecisionBatchResult, ApiRequestError, DecisionBatchInput>({
    mutationFn: (input) =>
      cmd("decisions.answerBatch", input, { reason: "Owner answered decisions in a batch" }),
    onSuccess: (result) => after(result),
  });
}
