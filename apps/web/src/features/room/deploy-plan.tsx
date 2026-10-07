import { DEPLOY_STATE_WORD, type DeployStepState, deployTone } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { inputsOf, type PlanStep, runsLine } from "@/features/deploy/deploy-model";
import { TaskLink } from "@/features/deploy/task-link";
import { TierChip } from "@/features/deploy/tier-chip";
import { useDeploy, useRollback } from "@/lib/deploy-queries";
import { describeError } from "@/lib/errors";
import { DockBar } from "./dock-bar";

/** States where nothing has started: the step shows who does it. Past these it shows how far it got. */
const NOT_STARTED: readonly DeployStepState[] = [
  "none",
  "planned",
  "held",
  "captain-next",
  "waits-for-owner",
  "waits-for-previous",
  "blocked",
];

const MOVING: readonly DeployStepState[] = ["queued", "running", "verifying"];

/** The plan shows until every step is live. */
export function deployPlanOpen(steps: readonly PlanStep[]): boolean {
  return steps.length > 0 && steps.some((s) => s.view.state !== "live");
}

/** How far a step got, for the right edge: the word, with the runs done when it has several. */
function progressWord(step: PlanStep["view"]): string {
  const word = DEPLOY_STATE_WORD[step.state];
  const states = step.runStates;
  if (step.state !== "running" || states === undefined || states.length < 2) return word;
  return `${word} ${states.filter((s) => s === "done").length}/${states.length}`;
}

/**
 * The deploy plan of a task, as one card in the room's dock: what goes where, in order. Planned, it offers Run
 * and Change; once a step moves it shows how far each one got. Read from the task's deploy records.
 */
export function DeployPlanCard({
  steps,
  change,
}: {
  steps: readonly PlanStep[];
  /** Puts the cursor in the room's message box. */
  change: () => void;
}) {
  const deploy = useDeploy();
  const rollback = useRollback();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const fail = (what: string) => (error: unknown) =>
    toast(what, { detail: describeError(error), tone: "error" });

  const views = steps.map((s) => s.view);
  const failed = views.some((v) => v.state === "failed" || v.state === "rolled-back");
  const moving = views.some((v) => MOVING.includes(v.state));
  const held = steps.filter((s) => s.view.state === "held");
  const planned = steps.filter((s) => s.view.state === "planned" && s.view.record !== undefined);
  const notes = [
    ...new Set(
      steps.flatMap((s) => (s.view.state !== "held" && s.view.note !== undefined ? [s.view.note] : [])),
    ),
  ];
  const envs = [...new Set(views.map((v) => v.env))];
  const busy = starting || deploy.isPending || rollback.isPending;

  const run = async () => {
    setStarting(true);
    try {
      for (const step of planned) {
        if (step.view.record === undefined) continue;
        await deploy.mutateAsync({ record: step.view.record });
      }
    } catch (error) {
      fail("Could not deploy")(error);
    } finally {
      setStarting(false);
    }
  };

  const title = failed
    ? `Deploy ${DEPLOY_STATE_WORD[views.some((v) => v.state === "failed") ? "failed" : "rolled-back"]}`
    : moving
      ? "Deploying"
      : "Deploy plan";
  const lamp = moving && !failed ? "working" : "needs";
  const line = moving
    ? views
        .filter((v) => v.state !== "live")
        .map((v) => `${v.env} ${DEPLOY_STATE_WORD[v.state]}`)
        .join(", ")
    : `To ${envs.join(", ")}`;

  return (
    <DockBar
      label="Deploy plan"
      lamp={lamp}
      title={title}
      line={held.length > 0 && !moving && !failed ? `${line}. Migration needs you.` : line}
      actions={
        moving ? undefined : (
          <>
            {planned.length > 0 && (
              <Button
                size="sm"
                variant="primary"
                data-primary-action=""
                disabled={busy}
                onClick={() => void run()}
              >
                Run
              </Button>
            )}
            <Button size="sm" onClick={change}>
              Change
            </Button>
          </>
        )
      }
      below={
        <>
          <ol className="m-0 mt-1 flex list-none flex-col p-0 pl-4">
            {steps.map(({ view, canRollBack }, i) => {
              const inputs = inputsOf(view.runs ?? []).join(" · ");
              const started = !NOT_STARTED.includes(view.state);
              const bad = view.state === "failed" || view.state === "rolled-back";
              return (
                <li
                  key={view.record ?? `${view.project}:${view.env}`}
                  className="grid min-h-9 grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-3 border-t border-line py-1.5 text-sm first:border-t-0"
                >
                  <span className="pt-0.5 font-mono text-xs text-fg-faint">
                    {view.seq === undefined || view.seq === 0 ? i + 1 : view.seq}
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-medium text-fg">{view.env}</span>
                      {view.tier !== undefined && <TierChip tier={view.tier} />}
                      {view.runs !== undefined && (
                        <span className="truncate font-mono text-xs text-fg-soft">{runsLine(view.runs)}</span>
                      )}
                    </div>
                    {inputs !== "" && (
                      <span className="min-w-0 truncate font-mono text-xs text-fg-faint" title={inputs}>
                        {inputs}
                      </span>
                    )}
                    {bad && view.why !== undefined && (
                      <span className="text-xs text-red text-pretty">{view.why}</span>
                    )}
                  </div>
                  <span className="flex items-center gap-2 text-xs text-fg-muted">
                    {started ? (
                      <>
                        {view.incident !== undefined && <TaskLink id={view.incident} />}
                        {canRollBack && view.record !== undefined && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-xs"
                            disabled={busy}
                            onClick={() =>
                              view.record !== undefined &&
                              rollback.mutate(
                                { record: view.record },
                                { onError: fail("Could not roll back") },
                              )
                            }
                          >
                            Roll back
                          </Button>
                        )}
                        <Lamp state={deployTone(view.state)} />
                        {progressWord(view)}
                      </>
                    ) : view.who === "owner" ? (
                      "You"
                    ) : (
                      "Captain"
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
          {held.map(({ view }) => (
            <div
              key={view.record ?? `${view.project}:${view.env}`}
              className="ml-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-line bg-amber-wash px-2.5 py-1.5 text-sm"
            >
              <span className="font-medium text-amber">Migration</span>
              {view.note !== undefined && <span className="text-fg-muted">{view.note}</span>}
              <span className="flex-1" />
              <Button
                size="sm"
                disabled={busy || view.record === undefined}
                onClick={() =>
                  view.record !== undefined &&
                  deploy.mutate({ record: view.record }, { onError: fail("Could not deploy") })
                }
              >
                Allow
              </Button>
            </div>
          ))}
          {notes.length > 0 && (
            <div className="ml-4 flex flex-col gap-0.5 text-xs text-fg-faint">
              {notes.map((note) => (
                <span key={note}>{note}</span>
              ))}
            </div>
          )}
        </>
      }
    />
  );
}
