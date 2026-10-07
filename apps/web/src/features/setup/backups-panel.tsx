import { type BackupInfo, RESTART_COMMAND } from "@majhi/shared";
import { type ReactNode, useState } from "react";
import { InlineCommand } from "@/components/command-line";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { Modal } from "@/components/ui/modal";
import { Dot } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import {
  useBackupNow,
  useBackups,
  useCancelRestore,
  useRestoreBackup,
  useSetBackupFolder,
  useVerifyBackup,
} from "@/lib/backup-queries";
import { describeError } from "@/lib/errors";
import { formatAgo, formatBytes } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { FolderBrowser } from "../roots/folder-browser";

const KIND_LABEL: Record<BackupInfo["kind"], string> = {
  daily: "Daily",
  manual: "On request",
  "before-update": "Before an update",
  "before-migration": "Before a migration",
  "before-restore": "Before a restore",
};

/** "in 5 h", "in 20 min", or "due" once the time has passed. */
function formatIn(iso: string, now: number): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "due";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[116px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 text-base @[560px]:grid-cols-[148px_minmax(0,1fr)]">
      <dt className="text-fg-faint">{label}</dt>
      <dd className="m-0 min-w-0 text-pretty break-words">{children}</dd>
    </div>
  );
}

/**
 * Backups of everything majhi cannot rebuild: the database, memory, the config history with agent
 * and skill files, and the encrypted secrets file. One archive each, locked with the secrets key
 * (or a passphrase), daily and before every update. A weekly test restore proves they work. A
 * restore checks the backup, backs up what is there, and restarts majhi onto the restored data.
 */
export function BackupsSection({ home }: { home: string }) {
  const backups = useBackups();
  const backupNow = useBackupNow();
  const verify = useVerifyBackup();
  const restore = useRestoreBackup();
  const cancel = useCancelRestore();
  const setFolder = useSetBackupFolder();
  const toast = useToast();
  const now = useNow(60_000);
  const [restoring, setRestoring] = useState<BackupInfo>();
  const [checking, setChecking] = useState<BackupInfo>();
  const [locking, setLocking] = useState(false);
  const [picking, setPicking] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const list = backups.data;
  const busy = list?.busy;
  const working = busy !== undefined || backupNow.isPending || verify.isPending || restore.isPending;
  const newest = list?.backups[0];

  function check(b: BackupInfo | undefined, phrase?: string) {
    verify.mutate(
      {
        ...(b === undefined ? {} : { name: b.name }),
        ...(phrase === undefined ? {} : { passphrase: phrase }),
      },
      {
        onSuccess: ({ result }) => {
          setChecking(undefined);
          setPassphrase("");
          toast(result.ok ? "The test restore worked" : "The test restore failed", {
            detail: result.detail,
            tone: result.ok ? "success" : "error",
          });
        },
        onError: (error) => {
          if (phrase === undefined) toast("Could not test", { detail: describeError(error), tone: "error" });
        },
      },
    );
  }

  return (
    <>
      {list?.pending && (
        <DetailSection title="Restore waiting" className="border-t-0">
          <p className="text-sm text-fg-muted text-pretty">
            majhi is restarting onto the restored data. If it does not come back within a minute, run{" "}
            <InlineCommand command={RESTART_COMMAND} /> on your machine.
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
      {list?.restored && (
        <DetailSection title="Last restore" className="border-t-0">
          <p className={list.restored.ok ? "text-sm text-fg-muted" : "text-sm text-red"}>
            {new Date(list.restored.at).toLocaleString()}: {list.restored.detail}
          </p>
        </DetailSection>
      )}
      <DetailSection
        title="Status"
        {...(list?.pending || list?.restored ? {} : { className: "border-t-0" })}
        actions={
          <>
            <Button size="sm" disabled={working} onClick={() => check(newest)}>
              {busy === "verify" || verify.isPending ? "Testing" : "Test restore"}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={working}
              onClick={() =>
                backupNow.mutate(undefined, {
                  onSuccess: () => toast("Backed up"),
                  onError: (error) =>
                    toast("Could not back up", { detail: describeError(error), tone: "error" }),
                })
              }
            >
              {busy === "backup" || backupNow.isPending ? "Backing up" : "Back up now"}
            </Button>
          </>
        }
      >
        {backups.isPending && <p className="text-sm text-fg-faint">Loading</p>}
        {backups.isError && <p className="text-sm text-red">{describeError(backups.error)}</p>}
        {list && (
          <dl className="m-0 flex max-w-[860px] flex-col">
            <Row label="Last backup">
              {list.lastAt ? (
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span>{formatAgo(list.lastAt, now)}</span>
                  <span className="text-fg-faint">{newest ? formatBytes(newest.bytes) : ""}</span>
                </span>
              ) : (
                <span className="text-fg-faint">
                  None yet. majhi takes the first one soon after it starts.
                </span>
              )}
            </Row>
            <Row label="Next daily">
              <span>{list.nextAt ? formatIn(list.nextAt, now) : "-"}</span>
              <span className="text-fg-faint">
                {" · "}
                {list.keep.daily} daily and {list.keep.weekly} weekly kept
              </span>
            </Row>
            <Row label="Folder">
              <span className="block min-w-0 break-all font-mono text-sm">{list.destination.path}</span>
              <span className="-ml-2.5 flex flex-wrap items-center gap-x-1">
                <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>
                  Change
                </Button>
                {list.destination.custom && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={setFolder.isPending}
                    onClick={() =>
                      setFolder.mutate(null, {
                        onError: (error) =>
                          toast("Could not change the folder", {
                            detail: describeError(error),
                            tone: "error",
                          }),
                      })
                    }
                  >
                    Use the default
                  </Button>
                )}
              </span>
              {list.destination.error && (
                <p className="m-0 text-sm text-red text-pretty">{list.destination.error}</p>
              )}
            </Row>
            <Row label="Test restore">
              {list.lastVerify ? (
                <span className="flex items-baseline gap-2">
                  <Dot tone={list.lastVerify.ok ? "green" : "red"} />
                  <span className="min-w-0 text-pretty">
                    {list.lastVerify.ok ? "Worked" : "Failed"} {formatAgo(list.lastVerify.at, now)}.{" "}
                    <span className={list.lastVerify.ok ? "text-fg-faint" : "text-red"}>
                      {list.lastVerify.detail}
                    </span>
                  </span>
                </span>
              ) : (
                <span className="text-fg-faint">Not yet. majhi runs one every week.</span>
              )}
            </Row>
            <Row label="Locked with">
              <span>The secrets key</span>
              <p className="m-0 text-sm text-fg-faint text-pretty">
                Without its export, a backup cannot be opened on a new computer.
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="-ml-2.5"
                disabled={working}
                onClick={() => setLocking(true)}
              >
                Back up with a passphrase instead
              </Button>
            </Row>
          </dl>
        )}
        {list?.lastError && (
          <p
            role="alert"
            className="max-w-[860px] rounded-md border border-red-line bg-red-wash px-3 py-2 text-sm text-red text-pretty"
          >
            The last backup failed {formatAgo(list.lastError.at, now)}: {list.lastError.detail}
          </p>
        )}
      </DetailSection>
      <DetailSection
        title="Backups"
        note={
          list
            ? "Database, memory, config history with agent and skill files, and the sealed secrets file"
            : undefined
        }
      >
        {list && list.backups.length === 0 && (
          <p className="text-sm text-fg-faint text-pretty">No backup yet.</p>
        )}
        {list && list.backups.length > 0 && (
          <ul aria-label="Backups" className="m-0 flex max-w-[860px] list-none flex-col p-0">
            {list.backups.map((b) => (
              <li
                key={b.name}
                className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2 first:border-t-0"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base">
                    {new Date(b.at).toLocaleString()}
                    <Badge tone={b.kind === "daily" ? "neutral" : "blue"}>{KIND_LABEL[b.kind]}</Badge>
                    {b.lock === "passphrase" && <Badge tone="amber">Passphrase</Badge>}
                    {b.legacy && <Badge>Database only</Badge>}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-fg-faint">
                    <span>
                      {formatAgo(b.at, now)}, {formatBytes(b.bytes)}
                    </span>
                    {b.verified && (
                      <span className={b.verified.ok ? "text-green" : "text-red"}>
                        {b.verified.ok ? "Tested" : "Test failed"} {formatAgo(b.verified.at, now)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={working}
                    aria-label={`Test the backup of ${new Date(b.at).toLocaleString()}`}
                    onClick={() => (b.lock === "passphrase" ? setChecking(b) : check(b))}
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={working || list.pending !== undefined}
                    aria-label={`Restore the backup of ${new Date(b.at).toLocaleString()}`}
                    onClick={() => setRestoring(b)}
                  >
                    Restore
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      {picking && list && (
        <Modal label="Choose the backup folder" onClose={() => setPicking(false)} className="w-[640px]">
          <FolderBrowser
            home={home}
            startPath={list.destination.path.startsWith("/") ? list.destination.path : home}
            chosen={new Set(list.destination.custom ? [list.destination.path] : [])}
            counts={new Map()}
            onClose={() => setPicking(false)}
            onPick={(path) =>
              setFolder.mutate(path, {
                onSuccess: () => {
                  setPicking(false);
                  toast("Backups go to the new folder");
                },
                onError: (error) => {
                  setPicking(false);
                  toast("Could not use that folder", { detail: describeError(error), tone: "error" });
                },
              })
            }
          />
        </Modal>
      )}

      {locking && (
        <ConfirmDialog
          title="Back up with a passphrase"
          body={
            <>
              <p className="m-0 text-pretty">
                This backup opens only with the passphrase. majhi does not keep it: if you lose it, the backup
                cannot be opened.
              </p>
              <PassphraseField
                value={passphrase}
                onChange={setPassphrase}
                label="Passphrase, 8+ characters"
              />
            </>
          }
          confirmLabel="Back up"
          confirmDisabled={passphrase.length < 8}
          busy={backupNow.isPending}
          error={backupNow.isError ? describeError(backupNow.error) : undefined}
          onCancel={() => {
            backupNow.reset();
            setPassphrase("");
            setLocking(false);
          }}
          onConfirm={() =>
            backupNow.mutate(
              { passphrase },
              {
                onSuccess: () => {
                  setLocking(false);
                  setPassphrase("");
                  toast("Backed up");
                },
              },
            )
          }
        />
      )}

      {checking && (
        <ConfirmDialog
          title="Test this backup"
          body={
            <>
              <p className="m-0 text-pretty">
                It was locked with a passphrase. Type it to restore the backup into a temporary folder and
                check it. Nothing live changes.
              </p>
              <PassphraseField value={passphrase} onChange={setPassphrase} label="Passphrase" />
            </>
          }
          confirmLabel="Test"
          confirmDisabled={passphrase === ""}
          busy={verify.isPending}
          error={verify.isError ? describeError(verify.error) : undefined}
          onCancel={() => {
            verify.reset();
            setPassphrase("");
            setChecking(undefined);
          }}
          onConfirm={() => check(checking, passphrase)}
        />
      )}

      {restoring && (
        <ConfirmDialog
          title="Restore this backup?"
          body={
            <div className="flex flex-col gap-2.5">
              <p className="m-0 text-pretty">
                majhi goes back to {new Date(restoring.at).toLocaleString()}. These are replaced:
              </p>
              <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
                {restoring.legacy ? (
                  <li>The database: tasks, rooms and history</li>
                ) : (
                  <>
                    <li>The database: tasks, rooms, decisions, findings and captain state</li>
                    <li>Memory</li>
                    <li>The config history, majhi.yaml, agent and skill files</li>
                    <li>The encrypted secrets file</li>
                  </>
                )}
              </ul>
              <p className="m-0 text-pretty">
                Everything since then leaves the live copy. majhi first backs up what is there and keeps the
                replaced files as a rollback. Account logins, connection credentials and the secrets key are
                not touched. majhi checks the backup, then restarts; the page is back in about a minute.
              </p>
              {restoring.lock === "passphrase" && (
                <PassphraseField value={passphrase} onChange={setPassphrase} label="Passphrase" />
              )}
            </div>
          }
          confirmLabel="Restore and restart"
          confirmDisabled={restoring.lock === "passphrase" && passphrase === ""}
          busy={restore.isPending}
          error={restore.isError ? describeError(restore.error) : undefined}
          onCancel={() => {
            restore.reset();
            setPassphrase("");
            setRestoring(undefined);
          }}
          onConfirm={() =>
            restore.mutate(
              { name: restoring.name, ...(restoring.lock === "passphrase" ? { passphrase } : {}) },
              {
                onSuccess: (out) => {
                  setRestoring(undefined);
                  setPassphrase("");
                  if (out.restarting) toast("Restoring. majhi restarts now");
                  else toast("Restore ready", { detail: `Run ${RESTART_COMMAND} to finish.` });
                },
              },
            )
          }
        />
      )}
    </>
  );
}

function PassphraseField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <Input
      type="password"
      autoComplete="off"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-3"
    />
  );
}
