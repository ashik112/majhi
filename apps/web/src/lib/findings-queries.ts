import type { CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** The most the sheet reads at once, newest first. The groups and filters are applied on the page. */
export const FINDINGS_LIMIT = 500;

/**
 * `findings.list`: the `findings` topic refetches it. `live` (the default) is every finding that is not
 * dismissed or fixed; `history` is the newest of every status, read only when the owner looks at
 * Dismissed, Fixed or All. Reading every status at once let a few hundred dismissed ones push the open ones
 * out of the newest 500, and the Open count came out far too low.
 */
export function useFindings(scope: "live" | "history" = "live", enabled = true) {
  return useQuery<CommandOutput<"findings.list">, ApiRequestError>({
    queryKey: [...queryKeys.findings, scope === "live" ? "live" : "list"],
    queryFn: () =>
      cmd(
        "findings.list",
        scope === "live" ? { status: "live", limit: FINDINGS_LIMIT } : { limit: FINDINGS_LIMIT },
      ),
    enabled,
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

/** Bring a dismissed finding back to open. For one Laya's triage dismissed: it labels that decision wrong. */
export function useFindingReopen() {
  const done = useRefetchAfter();
  return useMutation<CommandOutput<"findings.update">, ApiRequestError, { id: number }>({
    mutationFn: ({ id }) =>
      cmd("findings.update", { id, status: "open" }, { reason: "Owner brought back a finding" }),
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
