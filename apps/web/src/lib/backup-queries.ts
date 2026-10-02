import type { CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";

export type BackupList = CommandOutput<"backup.list">;

const KEY = ["backups"] as const;

/** The snapshots of majhi.db, newest first, and whether a restore waits for the next start. */
export function useBackups() {
  return useQuery<BackupList, ApiRequestError>({
    queryKey: KEY,
    queryFn: () => cmd("backup.list", {}),
  });
}

export function useBackupNow() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"backup.now">, ApiRequestError, void>({
    mutationFn: () => cmd("backup.now", {}, { reason: "Owner backed up majhi.db" }),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRestoreBackup() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"backup.restore">, ApiRequestError, string>({
    mutationFn: (name) => cmd("backup.restore", { name }, { reason: "Owner restored majhi.db" }),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCancelRestore() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"backup.cancelRestore">, ApiRequestError, void>({
    mutationFn: () => cmd("backup.cancelRestore", {}, { reason: "Owner cancelled the restore" }),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}
