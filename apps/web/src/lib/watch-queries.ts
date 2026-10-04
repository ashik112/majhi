import type { CommandInput, CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** The ops watch (SPEC 5.18): watched services, incidents, escalation and the phone push. The `ops` topic refetches them. */

/** `ops.overview`: every workspace's services and incidents, the phone and the escalation settings. */
export function useWatch() {
  return useQuery<CommandOutput<"ops.overview">, ApiRequestError>({
    queryKey: queryKeys.ops,
    queryFn: () => cmd("ops.overview", {}),
    // The latency lines and "5 min ago" move with the clock.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

function useRefetchWatch() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.ops }),
      client.invalidateQueries({ queryKey: queryKeys.decisions }),
      client.invalidateQueries({ queryKey: queryKeys.playbooks }),
      client.invalidateQueries({ queryKey: queryKeys.findings }),
    ]);
}

export function useSaveService() {
  const done = useRefetchWatch();
  return useMutation<CommandOutput<"ops.serviceSave">, ApiRequestError, CommandInput<"ops.serviceSave">>({
    mutationFn: (input) => cmd("ops.serviceSave", input, { reason: "Owner changed a watched service" }),
    onSuccess: done,
  });
}

export function useRemoveService() {
  const done = useRefetchWatch();
  return useMutation<CommandOutput<"ops.serviceRemove">, ApiRequestError, string>({
    mutationFn: (id) => cmd("ops.serviceRemove", { id }, { reason: "Owner stopped watching a service" }),
    onSuccess: done,
  });
}

export function useCheckNow() {
  const done = useRefetchWatch();
  return useMutation<CommandOutput<"ops.checkNow">, ApiRequestError, string>({
    mutationFn: (id) => cmd("ops.checkNow", { id }, { reason: "Owner checked a service now" }),
    onSuccess: done,
  });
}

export function useAckIncident() {
  const done = useRefetchWatch();
  return useMutation<CommandOutput<"ops.ack">, ApiRequestError, number>({
    mutationFn: (id) => cmd("ops.ack", { id }, { reason: "Owner acknowledged an incident" }),
    onSuccess: done,
  });
}

export function useWatchSettings() {
  const done = useRefetchWatch();
  return useMutation<CommandOutput<"ops.settings">, ApiRequestError, CommandInput<"ops.settings">>({
    mutationFn: (input) => cmd("ops.settings", input, { reason: "Owner changed the alert timing" }),
    onSuccess: done,
  });
}

export function usePhoneSetup() {
  const done = useRefetchWatch();
  return useMutation<CommandOutput<"ops.phoneSetup">, ApiRequestError, CommandInput<"ops.phoneSetup">>({
    mutationFn: (input) => cmd("ops.phoneSetup", input, { reason: "Owner set up the phone push" }),
    onSuccess: done,
  });
}

export function usePhoneSet() {
  const done = useRefetchWatch();
  return useMutation<CommandOutput<"ops.phoneSet">, ApiRequestError, CommandInput<"ops.phoneSet">>({
    mutationFn: (input) => cmd("ops.phoneSet", input, { reason: "Owner changed the phone push" }),
    onSuccess: done,
  });
}

export function usePhoneTest() {
  const done = useRefetchWatch();
  return useMutation<CommandOutput<"ops.phoneTest">, ApiRequestError, void>({
    mutationFn: () => cmd("ops.phoneTest", {}, { reason: "Owner sent a test push" }),
    onSuccess: done,
  });
}

export function usePhoneForget() {
  const done = useRefetchWatch();
  return useMutation<CommandOutput<"ops.phoneForget">, ApiRequestError, void>({
    mutationFn: () => cmd("ops.phoneForget", {}, { reason: "Owner turned the phone push off" }),
    onSuccess: done,
  });
}
