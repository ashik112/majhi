import type { OrgView, TriggerView } from "@majhi/shared";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OrgBadge } from "@/components/ui/org-badge";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { orgLabel } from "@/features/accounts/model";
import { useAutomationCommand } from "@/lib/automation-queries";
import { describeError } from "@/lib/errors";
import { badgeLetters, formatAgo } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { describeAction, formatSeconds, RUN_STATUS } from "./model";
import { GridRow, LastRun, RowActions, RowsPanel, StateBadge } from "./parts";
import { EmptyState } from "./schedule-list";

const COLUMNS = "minmax(0,1.4fr) minmax(0,1.3fr) minmax(0,1.5fr) minmax(0,1.4fr) 232px";

export function TriggerList({
  triggers,
  orgs,
  onEdit,
  onHistory,
  onCreate,
}: {
  triggers: readonly TriggerView[] | undefined;
  orgs: readonly OrgView[];
  onEdit: (trigger: TriggerView) => void;
  onHistory: (trigger: TriggerView) => void;
  onCreate: () => void;
}) {
  const now = useNow(30_000);
  const toast = useToast();
  const run = useAutomationCommand("triggers.runNow");
  const pause = useAutomationCommand("triggers.pause");
  const resume = useAutomationCommand("triggers.resume");
  const remove = useAutomationCommand("triggers.delete");
  const [deleting, setDeleting] = useState<TriggerView>();
  const [problem, setProblem] = useState<string>();

  if (triggers === undefined) return <RowsSkeleton rows={4} />;
  if (triggers.length === 0) return <EmptyState what="trigger" onCreate={onCreate} />;

  const busy = run.isPending || pause.isPending || resume.isPending;
  const fail = (e: unknown) => toast("Could not do that", { detail: describeError(e), tone: "error" });

  return (
    <>
      <RowsPanel label="Triggers" columns={COLUMNS} heads={["Trigger", "Watching", "Checks", "Last run", ""]}>
        {triggers.map((t) => {
          const org = orgLabel(t.org, orgs);
          const key = orgs.find((o) => o.id === t.org)?.key ?? t.org;
          return (
            <GridRow key={t.id} columns={COLUMNS}>
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onHistory(t)}
                    className="min-w-0 cursor-pointer truncate text-left text-base font-medium text-fg hover:underline"
                  >
                    {t.name}
                  </button>
                  <StateBadge paused={t.paused} />
                  {t.overlap === "allow" && <Badge title="Runs may overlap">Overlap allowed</Badge>}
                </div>
                <p className="line-clamp-2 text-sm text-fg-muted text-pretty">{describeAction(t.action)}</p>
                <p className="flex items-center gap-1.5 text-xs text-fg-faint">
                  <OrgBadge label={badgeLetters(key)} color={org.color} size="xs" />
                  {org.name}
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-base text-fg text-pretty">{t.watching}</span>
                <span className="font-mono text-xs text-fg-faint">{t.watch.kind}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="tnum text-sm text-fg-muted">
                  Every {formatSeconds(t.pollSeconds)} · settle {formatSeconds(t.settleSeconds)} · cooldown{" "}
                  {formatSeconds(t.cooldownSeconds)}
                </span>
                {t.checkError !== null ? (
                  <span role="alert" className="flex items-start gap-1.5 text-sm text-red text-pretty">
                    <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0">Could not check: {t.checkError}</span>
                  </span>
                ) : (
                  <span className="text-sm text-fg-faint">
                    {t.paused
                      ? "Not checking while paused"
                      : t.lastCheckedAt === null
                        ? "Not checked yet"
                        : `Checked ${formatAgo(t.lastCheckedAt, now)}`}
                  </span>
                )}
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-faint">
                  {t.pending && <Badge tone="amber">Change waiting</Badge>}
                  {t.lastFiredAt === null ? "Never fired" : `Fired ${formatAgo(t.lastFiredAt, now)}`}
                </span>
              </div>
              <LastRun run={t.lastRun} now={now} />
              <RowActions
                name={t.name}
                paused={t.paused}
                busy={busy}
                onRun={() =>
                  run.mutate(
                    { id: t.id },
                    {
                      onSuccess: (r) =>
                        toast(`Run now: ${RUN_STATUS[r.status].label.toLowerCase()}`, {
                          detail: r.detail,
                          tone: r.status === "failed" ? "error" : "success",
                        }),
                      onError: fail,
                    },
                  )
                }
                onToggle={() => (t.paused ? resume : pause).mutate({ id: t.id }, { onError: fail })}
                onHistory={() => onHistory(t)}
                onEdit={() => onEdit(t)}
                onDelete={() => {
                  setProblem(undefined);
                  setDeleting(t);
                }}
              />
            </GridRow>
          );
        })}
      </RowsPanel>
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          body="The trigger and its run history are removed. Tasks and processes it started are not touched."
          confirmLabel="Delete"
          busy={remove.isPending}
          error={problem}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() =>
            remove.mutate(
              { id: deleting.id },
              {
                onSuccess: () => setDeleting(undefined),
                onError: (e) => setProblem(describeError(e)),
              },
            )
          }
        />
      )}
    </>
  );
}
