import type {
  DecisionAnswerInput,
  DecisionBatchInput,
  DecisionBatchResult,
  DecisionDetail,
  DecisionList,
  OwnerDecision,
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

/** A decision's detail lives outside the list's key, so a refetch of the list never refetches details. */
const DETAIL_KEY = "decision-detail";

/**
 * What changes when a decision does: the list carries no version, so it is made from the fields the
 * list sends. A different string is a different decision to read again; the same string reuses the cache.
 */
export function decisionVersion(d: OwnerDecision): string {
  return [d.at, d.blocked ?? "", d.sentence ?? "", d.options.map((o) => o.id).join(",")].join("|");
}

/**
 * `decisions.detail`: the hand-back, diff stat, checks and target of the selected decision. Read only
 * for the one decision the owner has selected, keyed by its id and version, so it is read once and
 * again only when that decision changes. It is read only while the list still holds the decision: an
 * item that just left is not asked for again. One that leaves between the two reads answers 404,
 * which is an empty detail, not an error.
 */
export function useDecisionDetail(id: string | undefined) {
  // The version string: a card that asks renders again only when its decision changes or leaves.
  const version = useQuery<DecisionList, ApiRequestError, string | undefined>({
    ...decisionListQuery,
    select: (list) => {
      const found = id === undefined ? undefined : list.decisions.find((d) => d.id === id);
      return found === undefined ? undefined : decisionVersion(found);
    },
  }).data;
  return useQuery<DecisionDetail, ApiRequestError>({
    queryKey: [DETAIL_KEY, id, version],
    queryFn: async () => {
      try {
        return await cmd("decisions.detail", { id: id ?? "" });
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) return { id: id ?? "" };
        throw error;
      }
    },
    enabled: id !== undefined && version !== undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
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
      client.removeQueries({ queryKey: [DETAIL_KEY, input.id] });
      client.setQueryData(queryKeys.decisions, left);
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.tasks }),
        client.invalidateQueries({ queryKey: queryKeys.captain }),
        client.invalidateQueries({ queryKey: queryKeys.autonomy }),
        client.invalidateQueries({ queryKey: queryKeys.notices }),
      ]);
    },
  });
}

/** What still waits after a batch: the list, and the other places that count decisions. */
export function useAfterBatch() {
  const client = useQueryClient();
  return (result: DecisionBatchResult) => {
    if (result.done.length > 0) rememberAnswer();
    for (const id of result.done) client.removeQueries({ queryKey: [DETAIL_KEY, id] });
    client.setQueryData(queryKeys.decisions, { decisions: result.decisions, counts: result.counts });
    return Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.tasks }),
      client.invalidateQueries({ queryKey: queryKeys.captain }),
      client.invalidateQueries({ queryKey: queryKeys.autonomy }),
      client.invalidateQueries({ queryKey: queryKeys.notices }),
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
