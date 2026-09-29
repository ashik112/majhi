import type { CommandOutput } from "@majhi/shared";
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
