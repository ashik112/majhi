import type {
  DecisionAnswerInput,
  DecisionBatchInput,
  DecisionBatchResult,
  DecisionDetail,
  DecisionList,
} from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * `decisions.list`: everything that waits for the owner, ship and budget first, then oldest first.
 * The tasks, captain, autonomy and accounts topics refetch it.
 */
const decisionListQuery = {
  queryKey: queryKeys.decisions,
  queryFn: () => cmd("decisions.list", {}),
  // The feed refetches it when something that waits changes, and patches its counts when work starts or stops.
  staleTime: Number.POSITIVE_INFINITY,
  // A slow safety net, not the way the list stays current: an unchanged answer costs no render.
  refetchInterval: 60_000,
  refetchIntervalInBackground: false,
} as const;

export function useDecisions() {
  return useQuery<DecisionList, ApiRequestError>(decisionListQuery);
}

/**
 * `decisions.detail`: the hand-back, diff stat, checks and target of the selected decision. Kept under
 * the list's key, so the same topics refetch it. It is read only while the list still holds the
 * decision: an item that just left is not asked for again. One that leaves between the two reads
 * answers 404, which is an empty detail, not an error.
 */
export function useDecisionDetail(id: string | undefined) {
  // A boolean: a card that asks renders again only when its decision enters or leaves the list.
  const listed =
    useQuery<DecisionList, ApiRequestError, boolean>({
      ...decisionListQuery,
      select: (list) => id !== undefined && list.decisions.some((d) => d.id === id),
    }).data === true;
  return useQuery<DecisionDetail, ApiRequestError>({
    queryKey: [...queryKeys.decisions, "detail", id],
    queryFn: async () => {
      try {
        return await cmd("decisions.detail", { id: id ?? "" });
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) return { id: id ?? "" };
        throw error;
      }
    },
    enabled: id !== undefined && listed,
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
    onSuccess: (left, input) => {
      rememberAnswer();
      client.removeQueries({ queryKey: [...queryKeys.decisions, "detail", input.id] });
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
    for (const id of result.done) client.removeQueries({ queryKey: [...queryKeys.decisions, "detail", id] });
    client.setQueryData(queryKeys.decisions, { decisions: result.decisions, counts: result.counts });
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
