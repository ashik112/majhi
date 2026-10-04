import type { AutonomyStatus } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { PageLink } from "@/components/ui/page-link";
import { useToast } from "@/components/ui/toast";
import { useAutonomyCommand } from "@/lib/autonomy-queries";
import { useCaptainStatus } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { PAGE_PATH } from "@/lib/pages";
import { budgetText } from "./model";

/** Autonomous has one switch: turning it on, and turning it off in one of two ways. */
export function useAutonomyActions() {
  const toast = useToast();
  const start = useAutonomyCommand("autonomy.start");
  const stop = useAutonomyCommand("autonomy.stop");
  // A dialog closes in `onDone`, once the server agreed: a closed dialog would drop the error toast.
  const settle = (what: string, onDone: (() => void) | undefined) => ({
    onError: (error: Error) => toast(what, { detail: describeError(error), tone: "error" }),
    ...(onDone ? { onSuccess: onDone } : {}),
  });
  return {
    busy: start.isPending || stop.isPending,
    start,
    /** Pause its tasks now, or let them finish their step first. */
    turnOff: (how: "now" | "graceful", onDone?: () => void) =>
      stop.mutate(
        {
          input: { how },
          reason:
            how === "now"
              ? "Owner turned Autonomous off and paused its tasks"
              : "Owner turned Autonomous off and let its tasks finish their step",
        },
        settle("Could not turn Autonomous off", onDone),
      ),
  };
}

/** "PRV-105, UMB-6 and 2 more": a few ids, then a count. */
export function taskList(ids: readonly string[], max = 4): string {
  if (ids.length <= max) return ids.join(", ");
  return `${ids.slice(0, max).join(", ")} and ${ids.length - max} more`;
}

/** Opens the Limits screen, where the budgets are. */
function EditBudgets({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        onClose();
        void navigate({ to: PAGE_PATH.limits });
      }}
    >
      Edit budgets
    </Button>
  );
}

/**
 * Turning on: the budget and the workspaces it acts in, in plain words, and a checked box to resume
 * the tasks it paused when it was turned off.
 */
export function TurnOnDialog({ status, onClose }: { status: AutonomyStatus; onClose: () => void }) {
  const { start } = useAutonomyActions();
  const captain = useCaptainStatus().data;
  const paused = status.stopped;
  const [resume, setResume] = useState(true);
  // Every workspace where the captain decides something.
  const acts = (captain?.orgs ?? [])
    .filter((o) => Object.values(o.authority).includes("decide"))
    .map((o) => o.name);
  const noCaptain = status.boss === undefined;
  const day = status.settings.day;
  const noWorkspace = captain !== undefined && acts.length === 0;

  return (
    <Modal label="Turn Autonomous on" onClose={onClose} className="w-[480px]">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-md font-semibold">Turn Autonomous on</h2>
        <p className="text-base text-fg-muted text-pretty">
          The captain picks up work, answers questions and cards, and tidies up on its own, inside each
          workspace's rules. Every step lands in its log.
        </p>
        <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-base">
          <dt className="text-fg-muted">Budget</dt>
          <dd className="min-w-0 text-fg">
            {budgetText(day)}
            <span className="ml-2 text-sm text-fg-faint">
              {formatMoney(status.spend.total.used.cost)} spent today
            </span>
          </dd>
          <dt className="text-fg-muted">Acts in</dt>
          <dd className={noWorkspace ? "text-amber" : "min-w-0 break-words text-fg"}>
            {captain === undefined ? "Loading" : noWorkspace ? "No workspace yet" : acts.join(", ")}
          </dd>
        </dl>
        {noWorkspace && (
          <p className="rounded-md border border-amber-line bg-amber-wash px-3 py-2 text-base text-amber text-pretty">
            Nothing would happen yet. Open{" "}
            <PageLink page="captain" search={{ tab: "rules" }} onClick={onClose} className="underline">
              Delegation on the Captain page
            </PageLink>
            , let the captain decide something in one workspace, then come back.
          </p>
        )}
        {paused.length > 0 && (
          <label className="flex items-start gap-2.5 text-base text-fg">
            <input
              type="checkbox"
              checked={resume}
              onChange={(event) => setResume(event.target.checked)}
              className="mt-1"
            />
            <span className="min-w-0 text-pretty">
              Resume the {paused.length === 1 ? "task" : `${paused.length} tasks`} it paused
              <span className="text-fg-muted"> ({taskList(paused)})</span>
            </span>
          </label>
        )}
        {noCaptain && (
          <p
            role="alert"
            className="rounded-md border border-amber-line bg-amber-wash px-3 py-2 text-base text-amber text-pretty"
          >
            There is no captain yet. Pick one on the Agents page first.
          </p>
        )}
        {start.error && (
          <p
            role="alert"
            className="rounded-md border border-red-line bg-red-wash px-3 py-2 text-base text-red"
          >
            {describeError(start.error)}
          </p>
        )}
        <div className="flex items-center gap-2">
          <EditBudgets onClose={onClose} />
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={start.isPending || noCaptain || noWorkspace}
            onClick={() =>
              start.mutate(
                {
                  input: { resumeStopped: paused.length > 0 && resume },
                  reason: "Owner turned Autonomous on",
                },
                { onSuccess: onClose },
              )
            }
          >
            Turn on
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Turning off: pause its tasks now (the default), or let them finish the step they are on. One
 * sentence says what Off means; the captain still answers when the owner talks to it.
 */
export function OffDialog({ status, onClose }: { status: AutonomyStatus; onClose: () => void }) {
  const actions = useAutonomyActions();
  const working = status.now.filter((n) => n.status === "running").map((n) => n.task);
  const stopping = status.mode === "stopping";

  return (
    <Modal label="Turn Autonomous off" onClose={onClose} className="w-[460px]">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-md font-semibold">
          {stopping ? "Autonomous is turning off" : "Turn Autonomous off?"}
        </h2>
        <p className="text-base text-fg-muted text-pretty">
          {stopping
            ? "Its tasks are finishing the step they are on."
            : "The captain stops starting work, answering and shipping by itself. It still answers when you talk to it, and keeps memory and cleanup going."}
          {working.length > 0 && !stopping && (
            <span className="text-fg-faint"> Working now: {taskList(working)}.</span>
          )}
        </p>
        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            size="lg"
            disabled={actions.busy}
            onClick={() => actions.turnOff("now", onClose)}
          >
            {stopping ? "Pause its tasks now" : "Turn off and pause its tasks"}
          </Button>
          {!stopping && working.length > 0 && (
            <Button size="lg" disabled={actions.busy} onClick={() => actions.turnOff("graceful", onClose)}>
              Turn off, let them finish this step
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <EditBudgets onClose={onClose} />
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {stopping ? "Close" : "Keep it on"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
