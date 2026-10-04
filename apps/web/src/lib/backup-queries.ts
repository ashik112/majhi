import type { CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";

export type BackupList = CommandOutput<"backup.list">;

const KEY = ["backups"] as const;
/** Checks quickly while something runs, so the buttons and the status follow it. */
const BUSY_POLL_MS = 1500;

/** The backups, newest first, where they go, the last test restore and whether a restore waits. */
export function useBackups() {
  return useQuery<BackupList, ApiRequestError>({
    queryKey: KEY,
    queryFn: () => cmd("backup.list", {}),
    refetchInterval: (query) => (query.state.data?.busy === undefined ? 60_000 : BUSY_POLL_MS),
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: KEY });
}

export function useBackupNow() {
  const refresh = useRefresh();
  return useMutation<CommandOutput<"backup.now">, ApiRequestError, { passphrase?: string } | undefined>({
    mutationFn: (input) =>
      cmd("backup.now", input?.passphrase === undefined ? {} : { passphrase: input.passphrase }, {
        reason: "Owner backed up majhi's data",
      }),
    onSettled: refresh,
  });
}

export function useVerifyBackup() {
  const refresh = useRefresh();
  return useMutation<CommandOutput<"backup.verify">, ApiRequestError, { name?: string; passphrase?: string }>(
    {
      mutationFn: (input) => cmd("backup.verify", input),
      onSettled: refresh,
    },
  );
}

export function useRestoreBackup() {
  const refresh = useRefresh();
  return useMutation<CommandOutput<"backup.restore">, ApiRequestError, { name: string; passphrase?: string }>(
    {
      mutationFn: (input) => cmd("backup.restore", input, { reason: "Owner restored majhi's data" }),
      onSettled: refresh,
    },
  );
}

export function useCancelRestore() {
  const refresh = useRefresh();
  return useMutation<CommandOutput<"backup.cancelRestore">, ApiRequestError, void>({
    mutationFn: () => cmd("backup.cancelRestore", {}, { reason: "Owner cancelled the restore" }),
    onSettled: refresh,
  });
}

export function useSetBackupFolder() {
  const refresh = useRefresh();
  return useMutation<CommandOutput<"backup.setDestination">, ApiRequestError, string | null>({
    mutationFn: (path) => cmd("backup.setDestination", { path }, { reason: "Owner chose the backup folder" }),
    onSettled: refresh,
  });
}
