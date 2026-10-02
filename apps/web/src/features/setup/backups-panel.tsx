import { type BackupInfo, RESTART_COMMAND } from "@majhi/shared";
import { useState } from "react";
import { InlineCommand } from "@/components/command-line";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DetailSection } from "@/components/ui/list-detail";
import { useToast } from "@/components/ui/toast";
import { useBackupNow, useBackups, useCancelRestore, useRestoreBackup } from "@/lib/backup-queries";
import { describeError } from "@/lib/errors";
import { formatAgo, formatBytes } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const KIND_LABEL: Record<BackupInfo["kind"], string> = {
  daily: "Daily",
  manual: "On request",
  "before-restore": "Before a restore",
};

/**
 * Snapshots of majhi.db (tasks, rooms, history): one a day, the newest 7 kept, and restore. A
 * restore snapshots what is there first and takes effect when majhi next starts.
 */
export function BackupsSection() {
  const backups = useBackups();
  const backupNow = useBackupNow();
  const restore = useRestoreBackup();
  const cancel = useCancelRestore();
  const toast = useToast();
  const now = useNow(60_000);
  const [picked, setPicked] = useState<BackupInfo>();
  const list = backups.data;

  return (
    <>
      {list?.pending && (
        <DetailSection title="Restore waiting" className="border-t-0">
          <p className="text-sm text-fg-muted text-pretty">
            The restore takes effect when majhi starts again: run <InlineCommand command={RESTART_COMMAND} />{" "}
            on your machine. Until then majhi keeps using its current database.
          </p>
          <div>
            <Button
              size="sm"
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate(undefined, {
                  onError: (error) =>
                    toast("Could not cancel", { detail: describeError(error), tone: "error" }),
                })
              }
            >
              Cancel the restore
            </Button>
          </div>
        </DetailSection>
      )}
      <DetailSection
        title="Snapshots"
        note={
          list
            ? `${list.lastDaily ? `Last daily ${formatAgo(list.lastDaily, now)}` : "No daily one yet"}, ${list.keep} kept of each kind`
            : undefined
        }
        {...(list?.pending ? {} : { className: "border-t-0" })}
      >
        <div>
          <Button
            size="sm"
            disabled={backupNow.isPending}
            onClick={() =>
              backupNow.mutate(undefined, {
                onSuccess: () => toast("Backed up majhi.db"),
                onError: (error) =>
                  toast("Could not back up", { detail: describeError(error), tone: "error" }),
              })
            }
          >
            {backupNow.isPending ? "Backing up" : "Back up now"}
          </Button>
        </div>
        {backups.isPending && <p className="text-sm text-fg-faint">Loading</p>}
        {backups.isError && <p className="text-sm text-red">{describeError(backups.error)}</p>}
        {list && list.backups.length === 0 && (
          <p className="text-sm text-fg-faint text-pretty">
            No snapshot yet. majhi takes the first one soon after it starts.
          </p>
        )}
        {list && list.backups.length > 0 && (
          <ul aria-label="Snapshots" className="m-0 flex max-w-[860px] list-none flex-col p-0">
            {list.backups.map((b) => (
              <li
                key={b.name}
                className="flex min-h-11 items-center gap-3 border-t border-line py-2 first:border-t-0"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-baseline gap-2 text-base">
                    {new Date(b.at).toLocaleString()}
                    <Badge tone={b.kind === "daily" ? "neutral" : "blue"}>{KIND_LABEL[b.kind]}</Badge>
                  </span>
                  <span className="text-xs text-fg-faint">
                    {formatAgo(b.at, now)}, {formatBytes(b.bytes)}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Restore the snapshot of ${new Date(b.at).toLocaleString()}`}
                  onClick={() => setPicked(b)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
      {picked && (
        <ConfirmDialog
          title="Restore this snapshot?"
          body={
            <>
              Tasks, rooms and history go back to {new Date(picked.at).toLocaleString()}. Everything since is
              lost, except in the snapshot majhi takes of the current database first. It takes effect when
              majhi starts again.
            </>
          }
          confirmLabel="Restore"
          busy={restore.isPending}
          error={restore.isError ? describeError(restore.error) : undefined}
          onCancel={() => {
            restore.reset();
            setPicked(undefined);
          }}
          onConfirm={() =>
            restore.mutate(picked.name, {
              onSuccess: () => {
                setPicked(undefined);
                toast("Restore waiting for the next start");
              },
            })
          }
        />
      )}
    </>
  );
}
