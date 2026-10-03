import { type CaptainAction, type CaptainStatus, CHORE_LABEL } from "@majhi/shared";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { clockTime } from "@/features/autonomy/model";
import { TaskRef } from "@/features/autonomy/task-ref";
import { useCaptainLog, useCaptainUndo } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";

const OUTCOME: Record<
  CaptainAction["outcome"],
  { word: string; tone: "neutral" | "green" | "amber" | "red" }
> = {
  done: { word: "Did", tone: "green" },
  asked: { word: "For you", tone: "amber" },
  skipped: { word: "Left", tone: "neutral" },
  failed: { word: "Failed", tone: "red" },
};

/**
 * The captain's log: every action with its reason and evidence, newest first, and Undo where Undo is
 * possible (a merge as a revert commit, a config change through its history). A push says it cannot
 * be undone. One workspace or all.
 */
export function CaptainLog({
  status,
  now,
  className,
}: {
  status: CaptainStatus;
  now: number;
  className?: string;
}) {
  const [org, setOrg] = useState<string>("");
  const log = useCaptainLog(org === "" ? undefined : org);
  const [undoing, setUndoing] = useState<CaptainAction>();
  const undo = useCaptainUndo();
  const toast = useToast();
  const name = (id: string) => status.orgs.find((o) => o.org === id)?.name ?? id;
  const actions = log.data?.actions ?? [];
  return (
    <section
      aria-label="The captain's log"
      className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl", GLASS, className)}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-base font-semibold text-fg">Log</h2>
        <Select
          aria-label="Workspace"
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          className="ml-auto h-7 w-auto text-sm"
        >
          <option value="">All workspaces</option>
          {status.orgs.map((o) => (
            <option key={o.org} value={o.org}>
              {o.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pt-1 pb-6 scroll-fade">
        {log.isError ? (
          <p role="alert" className="pt-2 text-sm text-red">
            Could not load the log: {describeError(log.error)}
          </p>
        ) : log.isPending ? (
          <RowsSkeleton rows={5} height={40} />
        ) : actions.length === 0 ? (
          <p className="pt-2 text-sm text-fg-faint text-pretty">
            Nothing yet. Each thing the captain does lands here with why, what it checked, and Undo where it
            can.
          </p>
        ) : (
          <ul className="flex flex-col">
            {actions.map((a) => (
              <li key={a.id} className="flex min-w-0 gap-2.5 border-t border-line py-2 first:border-t-0">
                <time
                  dateTime={a.at}
                  title={new Date(a.at).toLocaleString()}
                  className="tnum w-11 shrink-0 pt-[3px] font-mono text-xs text-fg-faint"
                >
                  {clockTime(a.at, now)}
                </time>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="min-w-0 text-sm text-fg-soft">
                    <Badge tone={OUTCOME[a.outcome].tone} className="mr-1.5 align-[1px]">
                      {OUTCOME[a.outcome].word}
                    </Badge>
                    {a.task && <TaskRef task={a.task} className="mr-1.5" />}
                    <span className="text-pretty">{a.text}</span>
                  </span>
                  <span className="text-xs text-fg-faint">
                    {name(a.org)} · {CHORE_LABEL[a.chore]}
                  </span>
                  <span className="text-sm text-fg-muted text-pretty">Why: {a.reason}</span>
                  {a.evidence && (
                    <span className="text-sm text-fg-faint text-pretty">Checked: {a.evidence}</span>
                  )}
                  {a.outcome === "done" && a.undo === "no" && a.undoNote && (
                    <span className="text-xs text-fg-faint text-pretty">No Undo: {a.undoNote}</span>
                  )}
                </span>
                {a.undo === "yes" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 self-start"
                    onClick={() => setUndoing(a)}
                  >
                    Undo
                  </Button>
                )}
                {a.undo === "done" && (
                  <Badge
                    className="shrink-0 self-start"
                    title={a.undoneAt === undefined ? undefined : new Date(a.undoneAt).toLocaleString()}
                  >
                    Undone
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {undoing && (
        <ConfirmDialog
          title="Undo this?"
          body={
            <span className="text-pretty">
              {undoing.text}.{" "}
              {undoing.chore === "ship"
                ? "A new commit reverts the merge; later work on the branch stays."
                : "It goes back the way it was."}
            </span>
          }
          confirmLabel="Undo"
          busy={undo.isPending}
          error={undo.error ? describeError(undo.error) : undefined}
          onConfirm={() =>
            undo.mutate(
              { id: undoing.id },
              {
                onSuccess: (done) => {
                  setUndoing(undefined);
                  toast("Undone", { detail: done.detail });
                },
              },
            )
          }
          onCancel={() => {
            undo.reset();
            setUndoing(undefined);
          }}
        />
      )}
    </section>
  );
}
