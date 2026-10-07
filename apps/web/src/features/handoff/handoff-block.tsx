import {
  HANDOFF_COMMAND_STEPS,
  HANDOFF_STRIKES,
  type HandoffCommandStep,
  type HandoffLog,
  type HandoffResult,
  type HandoffState,
  type HandoffStep,
  handoffFailedFacts,
  handoffSeconds,
} from "@majhi/shared";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight, FileText, RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { TaskRef } from "@/features/autonomy/task-ref";
import { useFindings, useFindingToTask } from "@/lib/findings-queries";
import { formatAgo } from "@/lib/format";
import { useCheckAgain, useHandoff, useRerunStep } from "@/lib/handoff-queries";

const STATUS_WORD: Record<HandoffStep["status"], string> = {
  pass: "passed",
  fail: "failed",
  timeout: "timed out",
  flaky: "flaky, so not green",
  none: "nothing to run",
  skipped: "not run",
  note: "to look at",
  existing: "already failing",
};

const STATUS_TEXT: Record<HandoffStep["status"], string> = {
  pass: "text-lamp-done",
  fail: "text-red",
  timeout: "text-red",
  flaky: "text-caution",
  none: "text-fg-faint",
  skipped: "text-fg-faint",
  note: "text-caution",
  existing: "text-caution",
};

function lampOf(state: HandoffState, result: HandoffResult | undefined): LampState {
  if (state.running || state.queued) return "working";
  if (result === undefined) return "idle";
  return result.verdict === "green" ? "done" : "needs";
}

const COMMAND_STEPS: readonly string[] = HANDOFF_COMMAND_STEPS;
const isCommandStep = (id: string): id is HandoffCommandStep => COMMAND_STEPS.includes(id);

/** Opens a step's whole output in the file viewer, at the line where its failure begins. */
export function LogLink({
  task,
  log,
  label = "Full log",
}: {
  task: string;
  log: HandoffLog;
  label?: string;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // On the task's own page its viewer opens; anywhere else the app's viewer, told which task.
  const own = pathname.startsWith(`/t/${task}`);
  return (
    <Button asChild size="sm" variant="secondary" className="shrink-0">
      <Link
        to="."
        search={(prev: object) => ({
          ...prev,
          file: log.path,
          fileLine: log.focus,
          ...(own ? {} : { fileTask: task }),
        })}
        title={`${log.lines.toLocaleString("en")} lines${log.cut === undefined ? "" : ", cut in the middle"}`}
      >
        <FileText aria-hidden="true" />
        {label}
      </Link>
    </Button>
  );
}

/** "Rerun Tests": runs that one step again. The others keep their last result. */
export function RerunButton({
  task,
  step,
  label,
  busy,
}: {
  task: string;
  step: HandoffCommandStep;
  label: string;
  busy: boolean;
}) {
  const rerun = useRerunStep(task);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0"
        disabled={busy || rerun.isPending}
        title={`Run only ${label.toLowerCase()} again`}
        onClick={() => rerun.mutate(step)}
      >
        <RotateCw aria-hidden="true" className={cn(rerun.isPending && "animate-spin")} />
        Rerun {label}
      </Button>
      {rerun.isError && <span className="text-sm text-red">{describeError(rerun.error)}</span>}
    </>
  );
}

/**
 * What failed, in typed fields: the step, its exit code and time, with its whole log and a rerun of
 * just that step. Shown on the review card without opening anything. Nothing while a check runs.
 */
export function FailedStep({ task, className }: { task: string; className?: string }) {
  const state = useHandoff(task).data;
  const failed = state?.current?.failed;
  if (state === undefined || failed === undefined || state.running || state.queued) return null;
  if (state.current?.verdict !== "red") return null;
  const facts = handoffFailedFacts(failed);
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-sm", className)}>
      <span className="font-medium text-red">Failed: {failed.label}</span>
      {facts.length > 0 && <span className="tnum text-fg-faint">{facts.join(" · ")}</span>}
      {failed.log !== undefined && <LogLink task={task} log={failed.log} />}
      {isCommandStep(failed.step) && (
        <RerunButton task={task} step={failed.step} label={failed.label} busy={false} />
      )}
    </div>
  );
}

/** A failure the base commit has too: what it is, and one click to open a task that fixes it. */
function ExistingFailure({
  task,
  existing,
}: {
  task: string;
  existing: NonNullable<HandoffStep["existing"]>;
}) {
  const open = useFindingToTask();
  const findings = useFindings("live");
  // The finding may already have a task (this check, another task's, or the captain's): then it is that task.
  const known = findings.data?.find((f) => f.id === existing.finding)?.task;
  const made = open.data?.task ?? known;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs text-fg-soft sm:ml-[156px]">
      {existing.problems.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-fg-faint">
          {existing.problems.slice(0, 5).map((p) => (
            <li key={p} className="break-words">
              {p}
            </li>
          ))}
          {existing.problems.length > 5 && <li>and {existing.problems.length - 5} more</li>}
        </ul>
      )}
      {existing.finding !== undefined && (
        <span className="flex flex-wrap items-center gap-2">
          {made === undefined ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={open.isPending}
              onClick={() => open.mutate({ id: existing.finding ?? 0 })}
              aria-label={`Open a task to fix the failure on ${existing.base} (${task})`}
            >
              Open a task to fix it
            </Button>
          ) : (
            <span className="flex items-center gap-1.5">
              Task <TaskRef task={made} />
            </span>
          )}
          {open.isError && <span className="text-red">{describeError(open.error)}</span>}
        </span>
      )}
    </div>
  );
}

/** The memory kill, with the page where the limit is raised. */
function MemoryLink({ task, limit }: { task: string; limit: string }) {
  const state = useHandoff(task).data;
  const project = state?.current?.steps.flatMap((s) => s.ran?.map((r) => r.project) ?? [])[0];
  return (
    <>
      The limit is {limit}.{" "}
      {project !== undefined && (
        <PageLink
          page="projects"
          search={{ project, section: "checks" }}
          className="text-blue underline-offset-2 hover:underline"
        >
          Raise it here
        </PageLink>
      )}
    </>
  );
}

/** One step: its label, how it ended and what it said, and the end of a failing command's output. */
function StepRow({ task, step, busy }: { task: string; step: HandoffStep; busy: boolean }) {
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
      {(step.log !== undefined || isCommandStep(step.id)) &&
        step.status !== "skipped" &&
        step.status !== "none" && (
          <div className="flex flex-wrap items-center gap-1.5 sm:ml-[156px]">
            {step.log !== undefined && <LogLink task={task} log={step.log} />}
            {isCommandStep(step.id) && step.status !== "pass" && (
              <RerunButton task={task} step={step.id} label={step.label} busy={busy} />
            )}
          </div>
        )}
      {step.ran !== undefined && step.ran.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-fg-faint sm:ml-[156px]">
          {step.ran.map((r) => (
            <li key={`${r.project}:${r.command}`} className="min-w-0 break-words">
              <span className="font-mono text-fg-muted">{r.command}</span> {r.from}
              {r.workdir === undefined ? "" : `, in ${r.workdir}`}
              {Object.entries(r.env).map(([k, v]) => (
                <span key={k} className="font-mono">
                  {" "}
                  {k}={v}
                </span>
              ))}
              {r.notes.map((n) => (
                <span key={n}>. {n}</span>
              ))}
            </li>
          ))}
        </ul>
      )}
      {step.existing !== undefined && <ExistingFailure task={task} existing={step.existing} />}
      {step.memory !== undefined && (
        <p className="m-0 text-xs text-fg-soft sm:ml-[156px]">
          <MemoryLink task={task} limit={step.memory.limit} />
        </p>
      )}
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

function Details({
  task,
  state,
  result,
  busy,
}: {
  task: string;
  state: HandoffState;
  result: HandoffResult | undefined;
  busy: boolean;
}) {
  const now = Date.now();
  return (
    <div className="flex min-w-0 flex-col gap-2 pl-4">
      {result !== undefined && (
        <ul className="m-0 flex list-none flex-col p-0">
          {result.steps
            .filter((s) => s.id !== "review")
            .map((s) => (
              <StepRow key={s.id} task={task} step={s} busy={busy} />
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
      {open && <Details task={task} state={state} result={result} busy={busy} />}
    </section>
  );
}
