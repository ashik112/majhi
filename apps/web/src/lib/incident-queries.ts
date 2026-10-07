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
