import type { CommandOutput, IncidentView, ReportText } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** `incident.view`: what the client rooms of an incident task see, and its report. The `clients` topic refetches it. */
export function useIncident(task: string, enabled: boolean) {
  return useQuery<IncidentView | null, ApiRequestError>({
    queryKey: [...queryKeys.incident, task],
    queryFn: () => cmd("incident.view", { task }),
    enabled,
  });
}

function useRefetch() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.incident }),
      client.invalidateQueries({ queryKey: queryKeys.clients }),
      client.invalidateQueries({ queryKey: queryKeys.conversations }),
    ]);
}

export function useEditReport() {
  const done = useRefetch();
  return useMutation<
    CommandOutput<"incident.editReport">,
    ApiRequestError,
    { task: string; version: "internal" | "client"; text: Partial<ReportText> }
  >({
    mutationFn: (input) => cmd("incident.editReport", input),
    onSuccess: done,
  });
}

export function useSendReport() {
  const done = useRefetch();
  return useMutation<CommandOutput<"incident.sendReport">, ApiRequestError, { task: string; room: string }>({
    mutationFn: (input) => cmd("incident.sendReport", input),
    onSuccess: done,
  });
}

/** `incident.askCaptain`: the owner asks the workspace's captain to look at an incident now. */
export function useAskCaptain() {
  return useMutation<CommandOutput<"incident.askCaptain">, ApiRequestError, string>({
    mutationFn: (task) => cmd("incident.askCaptain", { task }),
  });
}

/** An incident's own Needs-you card answered from the task page: the same call the card makes. */
export function useAnswerIncident() {
  const done = useRefetch();
  const client = useQueryClient();
  return useMutation<unknown, ApiRequestError, { id: string; option: string }>({
    mutationFn: (input) => cmd("decisions.answer", input),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.decisions });
      await done();
    },
  });
}
