import type { DeployRecord } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";
import { useRollback } from "@/lib/deploy-queries";
import { formatAgo } from "@/lib/format";
import { HISTORY_ROWS, incidentNote, rollbackRecordIds, shortSha, stateLook } from "./deploy-model";
import { TaskLink } from "./task-link";

const COLUMNS = "@[560px]:grid @[560px]:grid-cols-[76px_88px_64px_72px_minmax(0,1fr)]";
const HEADS = ["When", "Where", "Commit", "Task", "Check"];

/** The deploys so far, newest first. Shows nothing when there are none. */
export function History({ history }: { history: readonly DeployRecord[] }) {
  const rollback = useRollback();
  const [failed, setFailed] = useState<{ record: number; message: string } | undefined>();
  if (history.length === 0) return null;
  const rows = history.slice(0, HISTORY_ROWS);
  const canRollBack = rollbackRecordIds(history);
  const note = incidentNote(history);
  const now = Date.now();
  return (
    <section aria-label="History" className="flex min-w-0 flex-col gap-1 border-t border-line pt-3">
      <div className="flex min-h-7 items-center">
        <h3 className="text-base font-semibold text-fg">History</h3>
      </div>
      <div className="overflow-hidden rounded-[10px] border border-line-strong">
        <div
          aria-hidden="true"
          className={cn("hidden items-center gap-2 bg-raised px-2.5 py-1.5 text-xs text-fg-faint", COLUMNS)}
        >
          {HEADS.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
        {rows.map((r) => {
          const look = stateLook(r);
          const bad = r.state === "failed" || r.state === "rolled-back";
          const message = failed?.record === r.id ? failed.message : undefined;
          return (
            <div
              key={r.id}
              className={cn(
                "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2 text-sm @[560px]:gap-x-2",
                COLUMNS,
                "border-t border-line [&:nth-child(2)]:border-t-0 @[560px]:[&:nth-child(2)]:border-t",
                bad && "bg-red/[0.07]",
              )}
            >
              <span className="order-2 ml-auto text-xs text-fg-muted whitespace-nowrap @[560px]:order-none @[560px]:ml-0">
                {formatAgo(r.createdAt, now)}
              </span>
              <span
                className="order-1 min-w-0 truncate font-medium @[560px]:order-none @[560px]:font-normal"
                title={r.env}
              >
                {r.env}
              </span>
              <span className="order-1 font-mono text-xs @[560px]:order-none" title={r.commit}>
                {shortSha(r.commit)}
              </span>
              <span className="order-1 min-w-0 truncate font-mono text-xs text-fg-soft @[560px]:order-none">
                {r.task === undefined ? (
                  <span className="text-fg-faint">Owner</span>
                ) : (
                  <TaskLink id={r.task} />
                )}
              </span>
              <span
                className="order-3 flex w-full min-w-0 items-center gap-2 @[560px]:order-none @[560px]:w-auto"
                title={r.check?.detail ?? r.reason}
              >
                <Lamp state={look.lamp} />
                <span className={cn("min-w-0 truncate", bad ? "text-red" : "text-fg-soft")}>{look.word}</span>
                {canRollBack.has(r.id) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-xs"
                    disabled={rollback.isPending}
                    onClick={() => {
                      setFailed(undefined);
                      rollback.mutate(
                        { record: r.id },
                        { onError: (e) => setFailed({ record: r.id, message: e.message }) },
                      );
                    }}
                  >
                    Roll back
                  </Button>
                )}
              </span>
              {message !== undefined && (
                <p role="alert" className="order-4 w-full text-sm text-red text-pretty @[560px]:col-span-5">
                  {message}
                </p>
              )}
            </div>
          );
        })}
        {note !== undefined && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line bg-red/[0.07] px-2.5 py-2 text-sm text-fg-soft">
            <Lamp state="paused" />
            <span>
              <b className="font-mono text-xs font-semibold text-fg">{note.commit}</b> failed its check.
              {note.back !== undefined && (
                <>
                  {" "}
                  Rolled back to <span className="font-mono text-xs">{note.back}</span>.
                </>
              )}{" "}
              Incident <TaskLink id={note.incident} /> opened with the logs.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
