import { batchPlan, batchSummary, type DecisionBatchResult, type OwnerDecision } from "@majhi/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import type { Hold } from "./use-batch";

/** Seconds until a held batch is sent, counting down. */
function useCountdown(at: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [at]);
  return at === undefined ? 0 : Math.max(0, Math.ceil((at - now) / 1000));
}

const word = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The strip under the queue. With rows checked it offers Approve N and Leave N and says in a line what
 * each will do; with none checked it offers "Approve all like this" for the selected decision's group.
 * After a click it counts down so the owner can take it back, then reports what was done and what was not.
 */
export function BatchBar({
  picked,
  selected,
  like,
  hold,
  sending,
  result,
  failure,
  onStart,
  onUndo,
  onNow,
  onClear,
  onSelectAll,
  onDismiss,
  total,
}: {
  picked: readonly OwnerDecision[];
  selected: OwnerDecision | undefined;
  /** The decisions like the selected one (same kind, same task). */
  like: readonly OwnerDecision[];
  hold: Hold | undefined;
  sending: boolean;
  result: DecisionBatchResult | undefined;
  failure: string | undefined;
  onStart: (intent: "approve" | "leave", ids: readonly string[]) => void;
  onUndo: () => void;
  onNow: () => void;
  onClear: () => void;
  onSelectAll: () => void;
  onDismiss: () => void;
  total: number;
}) {
  const seconds = useCountdown(hold?.at);
  const [open, setOpen] = useState(false);

  if (hold !== undefined) {
    const verb = hold.intent === "approve" ? "Approving" : "Leaving";
    return (
      <div role="status" className="flex flex-col gap-1.5 text-sm">
        <p className="m-0 text-fg">
          {verb} {hold.ids.length} in <span className="tnum font-mono">{seconds}</span>s
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={onUndo}>
            Undo
          </Button>
          <Button size="sm" variant="ghost" onClick={onNow}>
            Do it now
          </Button>
        </div>
      </div>
    );
  }

  if (sending) {
    return (
      <p role="status" className="m-0 text-sm text-fg-muted">
        Sending...
      </p>
    );
  }

  if (failure !== undefined) {
    return (
      <div role="alert" className="flex flex-col gap-1.5 text-sm">
        <p className="m-0 text-fg">It was not sent. Nothing changed.</p>
        <p className="m-0 text-xs text-fg-muted break-words">{failure}</p>
        <Button size="sm" className="self-start" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  }

  if (result !== undefined && picked.length === 0) {
    const bad = result.failed.length;
    const waits = result.skipped.filter((s) => s.reason !== "It was answered already").length;
    return (
      <div role="status" className="flex flex-col gap-1.5 text-sm">
        <p className="m-0 text-fg">
          {result.done.length} {result.intent === "approve" ? "approved" : "left"}
          {bad > 0 && `, ${bad} failed`}
          {waits > 0 && `, ${waits} left for you`}.
        </p>
        {bad > 0 && (
          <>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="cursor-pointer self-start rounded-sm p-0 text-xs text-fg-muted underline"
            >
              {open ? "Hide" : "Show"} the {word(bad, "failure", "failures")}
            </button>
            {open && (
              <ul className="m-0 flex max-h-28 list-none flex-col gap-1 overflow-y-auto p-0 text-xs text-fg-muted">
                {result.failed.map((f) => (
                  <li key={f.id} className="break-words">
                    {f.error}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <Button size="sm" variant="ghost" className="self-start px-2" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  }

  if (picked.length > 0) {
    const verb = picked.every((d) => d.kind === "ship") ? "Merge" : "Approve";
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg">{picked.length} picked</span>
        <Button
          size="sm"
          variant="primary"
          title={batchSummary(picked, "approve")}
          onClick={() =>
            onStart(
              "approve",
              picked.map((d) => d.id),
            )
          }
        >
          {verb} {picked.length}
        </Button>
        <Button
          size="sm"
          title={batchSummary(picked, "leave")}
          onClick={() =>
            onStart(
              "leave",
              picked.map((d) => d.id),
            )
          }
        >
          Leave {picked.length}
        </Button>
        <Button size="sm" variant="ghost" className="px-2" onClick={onClear}>
          Clear
        </Button>
      </div>
    );
  }

  const approvable = like.filter((d) => batchPlan([d], "approve").ids.length > 0);
  return (
    <div className="flex flex-col gap-1.5">
      {selected !== undefined && approvable.length > 1 && (
        <div className="flex flex-col gap-1">
          <Button
            size="sm"
            className="self-start"
            onClick={() =>
              onStart(
                "approve",
                approvable.map((d) => d.id),
              )
            }
          >
            Approve all like this ({approvable.length})
          </Button>
          <p className="m-0 text-xs text-fg-muted text-pretty">{batchSummary(approvable, "approve")}</p>
        </div>
      )}
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-faint">
        <span>
          <Kbd>x</Kbd> select
        </span>
        <span>
          <Kbd>Shift</Kbd>
          <Kbd>x</Kbd> to here
        </span>
        <button
          type="button"
          onClick={onSelectAll}
          className="cursor-pointer rounded-sm p-0 text-fg-muted underline"
        >
          Select all {total}
        </button>
      </p>
    </div>
  );
}
