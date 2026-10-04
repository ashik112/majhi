import type { CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** Every finding the sheet can show, newest first. The groups and filters are applied on the page. */
const FINDINGS_LIMIT = 500;

/** `findings.list`: the `findings` topic refetches it. */
export function useFindings() {
  return useQuery<CommandOutput<"findings.list">, ApiRequestError>({
    queryKey: [...queryKeys.findings, "list"],
    queryFn: () => cmd("findings.list", { limit: FINDINGS_LIMIT }),
  });
}

function useRefetchAfter() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.findings }),
      client.invalidateQueries({ queryKey: queryKeys.tasks }),
    ]);
}

/** Make a task from a finding, as the owner: it goes to the inbox. */
export function useFindingToTask() {
  const done = useRefetchAfter();
  return useMutation<CommandOutput<"findings.toTask">, ApiRequestError, { id: number }>({
    mutationFn: ({ id }) => cmd("findings.toTask", { id }, { reason: "Owner made a task from a finding" }),
    onSuccess: done,
  });
}

/** Dismiss a finding with a reason. */
export function useFindingDismiss() {
  const done = useRefetchAfter();
  return useMutation<CommandOutput<"findings.dismiss">, ApiRequestError, { id: number; reason: string }>({
    mutationFn: (input) => cmd("findings.dismiss", input, { reason: "Owner dismissed a finding" }),
    onSuccess: done,
  });
}

/** Draft a proposal email from an opportunity finding. It waits in Decisions; nothing is sent. */
export function useFindingProposal() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"findings.proposal">, ApiRequestError, { id: number }>({
    mutationFn: ({ id }) => cmd("findings.proposal", { id }, { reason: "Owner asked for a proposal draft" }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.findings }),
        client.invalidateQueries({ queryKey: queryKeys.decisions }),
        client.invalidateQueries({ queryKey: queryKeys.playbooks }),
      ]),
  });
}

/** Add the deadline a grant or launch finding carries to the deadlines. */
export function useFindingDeadline() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"findings.deadline">, ApiRequestError, { id: number }>({
    mutationFn: ({ id }) => cmd("findings.deadline", { id }, { reason: "Owner confirmed a deadline" }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.findings }),
        client.invalidateQueries({ queryKey: ["business"] }),
        client.invalidateQueries({ queryKey: ["agenda"] }),
      ]),
  });
}
