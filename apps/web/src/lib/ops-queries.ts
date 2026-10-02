import type { CommandInput, CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

export const opsKeys = {
  checks: ["health-checks"],
  version: ["system-version"],
} as const;

/** Every doctor check. The sidebar reads it too, so it refreshes on its own every few minutes. */
export function useHealthChecks() {
  return useQuery<CommandOutput<"health.run">, ApiRequestError>({
    queryKey: opsKeys.checks,
    queryFn: () => cmd("health.run", {}),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}

/** Runs the fix behind a Fix button, then reads the checks again. */
export function useFixCheck() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"health.fix">, ApiRequestError, string>({
    mutationFn: (id) => cmd("health.fix", { id }, { reason: "Owner pressed Fix on a health check" }),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: opsKeys.checks }),
        client.invalidateQueries({ queryKey: queryKeys.accounts }),
        client.invalidateQueries({ queryKey: queryKeys.hostStatus }),
      ]);
    },
  });
}

/** Done tasks old enough for cleanup, and what a cleanup would do to each. Read again on every press. */
export function usePreviewCleanup() {
  return useMutation<CommandOutput<"cleanup.preview">, ApiRequestError, number>({
    mutationFn: (days) => cmd("cleanup.preview", { days }),
  });
}

/** Cleans up the chosen tasks. The server checks each one again. */
export function useRunCleanup() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"cleanup.run">, ApiRequestError, { tasks: string[]; days: number }>({
    mutationFn: (input) =>
      cmd("cleanup.run", input as CommandInput<"cleanup.run">, {
        reason: "Owner confirmed a cleanup of done tasks",
      }),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.tasks }),
  });
}

/** The running commit against the checkout on disk. Polled once a minute. */
export function useSystemVersion(refetchMs: number | false = 60_000) {
  return useQuery<CommandOutput<"system.version">, ApiRequestError>({
    queryKey: opsKeys.version,
    queryFn: () => cmd("system.version", {}),
    staleTime: 30_000,
    refetchInterval: refetchMs,
    retry: false,
  });
}

/** `now` rebuilds at once; `idle` waits until no agent is in a turn. */
export function useStartUpdate() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"system.update">, ApiRequestError, "now" | "idle">({
    mutationFn: (when) =>
      cmd(
        "system.update",
        { when },
        { reason: when === "idle" ? "Owner chose Update when they finish" : "Owner pressed Update" },
      ),
    onSettled: () => client.invalidateQueries({ queryKey: opsKeys.version }),
  });
}

/** Sends a test notification to the Mac and the open tabs, as the saved settings allow. */
export function useSendTestNotification() {
  return useMutation<CommandOutput<"notify.test">, ApiRequestError, undefined>({
    mutationFn: () => cmd("notify.test", {}, { reason: "Owner pressed Send a test notification" }),
  });
}

/** Exports the secrets key under a passphrase, then reads the checks again so the warning clears. */
export function useExportKey() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"secrets.exportKey">, ApiRequestError, CommandInput<"secrets.exportKey">>({
    mutationFn: (input) => cmd("secrets.exportKey", input, { reason: "Owner exported the secrets key" }),
    onSettled: () => client.invalidateQueries({ queryKey: opsKeys.checks }),
  });
}
