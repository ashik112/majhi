import {
  HANDOFF_STRIKES,
  type HandoffResult,
  type HandoffState,
  type HandoffStep,
  handoffSeconds,
} from "@majhi/shared";
import { ChevronRight, RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useCheckAgain, useHandoff } from "@/lib/handoff-queries";

const STATUS_WORD: Record<HandoffStep["status"], string> = {
  pass: "passed",
  fail: "failed",
  timeout: "timed out",
  flaky: "flaky, so not green",
  none: "nothing to run",
  skipped: "not run",
  note: "to look at",
};

const STATUS_TEXT: Record<HandoffStep["status"], string> = {
  pass: "text-lamp-done",
  fail: "text-red",
  timeout: "text-red",
  flaky: "text-caution",
  none: "text-fg-faint",
  skipped: "text-fg-faint",
  note: "text-caution",
};

function lampOf(state: HandoffState, result: HandoffResult | undefined): LampState {
  if (state.running || state.queued) return "working";
  if (result === undefined) return "idle";
  return result.verdict === "green" ? "done" : "needs";
}

/** One step: its label, how it ended and what it said, and the end of a failing command's output. */
function StepRow({ step }: { step: HandoffStep }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 py-1">
      <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
        <span className="w-[148px] shrink-0 text-fg-muted">{step.label}</span>
        <span className={cn("shrink-0 font-medium", STATUS_TEXT[step.status])}>
          {STATUS_WORD[step.status]}
        </span>
        {step.ms !== undefined && step.ms >= 1000 && (
          <span className="tnum shrink-0 text-xs text-fg-faint">{handoffSeconds(step.ms)}</span>
        )}
        <span className="min-w-0 flex-1 basis-[200px] break-words text-fg-soft text-pretty">
          {step.detail}
        </span>
      </p>
      {step.output !== undefined && step.output !== "" && (
        <pre className="m-0 ml-0 max-h-40 overflow-auto rounded-md border border-line-strong bg-sunken p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-fg-muted sm:ml-[156px]">
          {step.output}
        </pre>
      )}
      {step.items !== undefined && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs sm:ml-[156px]">
          {step.items.map((i) => (
            <li key={i.text} className="flex min-w-0 gap-1.5 text-fg-soft">
              <span className={cn("shrink-0", i.ok ? "text-lamp-done" : "text-caution")}>
                {i.ok ? "matched" : "no evidence"}
              </span>
              <span className="min-w-0 break-words">
                {i.text}
                {i.note !== undefined && i.ok && <span className="text-fg-faint"> ({i.note})</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Details({ state, result }: { state: HandoffState; result: HandoffResult | undefined }) {
  const now = Date.now();
  return (
    <div className="flex min-w-0 flex-col gap-2 pl-4">
      {result !== undefined && (
        <ul className="m-0 flex list-none flex-col p-0">
          {result.steps
            .filter((s) => s.id !== "review")
            .map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          <li className="flex min-w-0 flex-col gap-1 py-1">
            <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="w-[148px] shrink-0 text-fg-muted">Review</span>
              <span className="min-w-0 flex-1 basis-[200px] text-fg-soft text-pretty">
                {result.review.by === "model"
                  ? `A model read the change (about ${result.review.tokens.toLocaleString("en")} tokens).`
                  : result.review.by === "code"
                    ? `Free checks only${result.review.why === undefined ? "" : `: ${result.review.why}`}.`
                    : `Not run${result.review.why === undefined ? "" : `: ${result.review.why}`}.`}
              </span>
            </p>
            {result.review.notes.length > 0 && (
              <ul className="m-0 flex list-disc flex-col gap-0.5 pl-4 text-sm text-fg-soft sm:ml-[148px]">
                {result.review.notes.map((n) => (
                  <li key={n} className="break-words text-pretty">
                    {n}
                  </li>
                ))}
              </ul>
            )}
          </li>
        </ul>
      )}
      {result !== undefined && (
        <p className="m-0 text-xs text-fg-faint text-pretty">
          Checked {formatAgo(result.at, now)}, took {handoffSeconds(result.ms)}
          {result.cached ? ". The same commit is not run again." : "."}
          {state.stale && " The task has new commits since: the next check runs them."}
        </p>
      )}
      {state.strikes > 0 && (
        <p className="m-0 text-xs text-fg-muted text-pretty">
          {state.escalated
            ? `Failed ${state.strikes} times in a row. It is not sent back to the lead again: you decide.`
            : `Failed ${state.strikes} of ${HANDOFF_STRIKES} times in a row. Each time the exact failure went back to the lead.`}
        </p>
      )}
    </div>
  );
}

/**
 * What majhi checked before the work was called ready (SPEC 5.18): one line, collapsed, with the steps
 * behind it and a "Check again". Shown on the review card and on the Ship decision.
 */
export function HandoffBlock({ task, className }: { task: string; className?: string }) {
  const query = useHandoff(task);
  const again = useCheckAgain(task);
  const [open, setOpen] = useState(false);
  const state = query.data;
  if (state === undefined) return null;
  const result = state.current;
  if (result === undefined && !state.running && !state.queued) return null;
  const busy = state.running || state.queued || again.isPending;
  const summary =
    result === undefined
      ? state.queued
        ? "Waiting for a free slot to check it."
        : "Checking it."
      : state.running
        ? `Previous commit: ${result.summary}`
        : result.summary;
  return (
    <section aria-label="Hand-off check" className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-[7px] shrink-0">
          <Lamp state={lampOf(state, result)} size={8} />
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-1 rounded-sm bg-transparent p-0 py-0.5 text-left text-sm text-fg-soft hover:text-fg"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("mt-0.5 size-3.5 shrink-0 text-fg-faint transition-transform", open && "rotate-90")}
          />
          <span className="min-w-0 break-words text-pretty">
            {summary}
            {result !== undefined && result.verdict === "red" && !state.running && (
              <span className="text-red"> Not ready.</span>
            )}
          </span>
        </button>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          disabled={busy}
          title="Run the tests, build and lint again and read the change once more"
          onClick={() => again.mutate()}
        >
          <RotateCw aria-hidden="true" className={cn(busy && "animate-spin")} />
          {busy ? "Checking" : "Check again"}
        </Button>
      </div>
      {again.isError && <p className="m-0 pl-4 text-sm text-red text-pretty">{describeError(again.error)}</p>}
      {open && <Details state={state} result={result} />}
    </section>
  );
}
