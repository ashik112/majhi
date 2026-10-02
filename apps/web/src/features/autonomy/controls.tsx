import type { AutonomyMode, AutonomyStatus } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { PageLink } from "@/components/ui/page-link";
import { useToast } from "@/components/ui/toast";
import { useAutonomyCommand } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useOrgs } from "@/lib/studio-queries";
import { budgetText, capText, pickOrgsText, SIZE_LIMIT_WORD } from "./model";

/** Turn on, Pause, Resume and the two stops, each with the line the history keeps. */
export function useAutonomyActions() {
  const toast = useToast();
  const start = useAutonomyCommand("autonomy.start");
  const pause = useAutonomyCommand("autonomy.pause");
  const stop = useAutonomyCommand("autonomy.stop");
  // A dialog closes in `onDone`, once the server agreed: a closed dialog would drop the error toast.
  const settle = (what: string, onDone: (() => void) | undefined) => ({
    onError: (error: Error) => toast(what, { detail: describeError(error), tone: "error" }),
    ...(onDone ? { onSuccess: onDone } : {}),
  });
  return {
    busy: start.isPending || pause.isPending || stop.isPending,
    start,
    resume: (onDone?: () => void) =>
      start.mutate(
        { input: {}, reason: "Owner resumed autonomous mode" },
        settle("Could not resume autonomous mode", onDone),
      ),
    pause: (onDone?: () => void) =>
      pause.mutate(
        { input: {}, reason: "Owner paused autonomous mode" },
        settle("Could not pause autonomous mode", onDone),
      ),
    stop: (how: "now" | "graceful", onDone?: () => void) =>
      stop.mutate(
        {
          input: { how },
          reason:
            how === "now" ? "Owner stopped autonomous mode now" : "Owner stopped autonomous mode gracefully",
        },
        settle("Could not stop autonomous mode", onDone),
      ),
  };
}

/** The limits it turns on with: the day cap, each org's cap, and where it may push and merge. */
export function TurnOnDialog({ status, onClose }: { status: AutonomyStatus; onClose: () => void }) {
  const orgs = useOrgs().data ?? [];
  const { start } = useAutonomyActions();
  const settings = status.settings;
  const ids = [...new Set([...orgs.map((o) => o.id), ...Object.keys(settings.orgs)])];
  const name = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;

  return (
    <Modal label="Turn on autonomous mode" onClose={onClose} className="w-[500px]">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-md font-semibold">Turn on autonomous mode</h2>
        <p className="text-base text-fg-muted text-pretty">
          The captain picks work from the board and the workspace backlogs, starts it, and decides its own
          cards within these limits. Every decision lands in the log with one line why. You can pause or stop
          it at any time.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
          <dt className="text-fg-muted">Day cap</dt>
          <dd className="text-fg">
            {budgetText(settings.day)}
            <span className="ml-2 text-sm text-fg-faint">{capText(status.spend.total)} so far today</span>
          </dd>
          <dt className="text-fg-muted">Picks</dt>
          <dd className="text-fg">
            {SIZE_LIMIT_WORD[settings.pick.size]}. {pickOrgsText(settings.pick, name)}.
          </dd>
          <dt className="text-fg-muted">Accounts</dt>
          <dd className="text-fg">
            Keeps {settings.floors.window}% of each 5-hour window and {settings.floors.weekly}% of each week
          </dd>
        </dl>
        {ids.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-fg-faint">
              <tr>
                <th className="pb-1 font-normal">Workspace</th>
                <th className="pb-1 font-normal">Cap</th>
                <th className="pb-1 font-normal">Push</th>
                <th className="pb-1 font-normal">Merge</th>
              </tr>
            </thead>
            <tbody>
              {ids.map((id) => {
                const org = settings.orgs[id];
                return (
                  <tr key={id} className="border-t border-line">
                    <td className="py-1.5 pr-3 text-fg">{name(id)}</td>
                    <td className="py-1.5 pr-3 text-fg-soft">{budgetText(org?.cap)}</td>
                    <td className={cn("py-1.5 pr-3", org?.push ? "text-green" : "text-fg-faint")}>
                      {org?.push ? "Allowed" : "Off"}
                    </td>
                    <td className={cn("py-1.5", org?.merge ? "text-green" : "text-fg-faint")}>
                      {org?.merge ? "Allowed" : "Off"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="text-sm text-fg-faint">
          Change these under Rules on the{" "}
          <PageLink page="autonomous" onClick={onClose} className="text-blue hover:underline">
            Autonomous page
          </PageLink>
          .
        </p>
        {status.boss === undefined && (
          <p
            role="alert"
            className="rounded-md border border-amber-line bg-amber-wash px-3 py-2 text-base text-amber"
          >
            There is no captain yet. Pick one on Agents first: autonomous mode runs through it.
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
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={start.isPending || status.boss === undefined}
            onClick={() =>
              start.mutate({ input: {}, reason: "Owner turned autonomous mode on" }, { onSuccess: onClose })
            }
          >
            Turn on
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const STOP_NOW_BODY =
  "Every run of an autonomous task and the captain's own turn stop at once. Turns in progress are cut off, and those tasks stay paused for you.";

/** What switching it off offers: Pause (or Resume), Stop gracefully and Stop now, which asks first. */
export function OffDialog({ mode, onClose }: { mode: AutonomyMode; onClose: () => void }) {
  const actions = useAutonomyActions();
  const [confirmNow, setConfirmNow] = useState(false);

  if (confirmNow)
    return (
      <ConfirmDialog
        title="Stop autonomous mode now?"
        body={STOP_NOW_BODY}
        confirmLabel="Stop now"
        busy={actions.busy}
        onConfirm={() => actions.stop("now", onClose)}
        onCancel={() => setConfirmNow(false)}
      />
    );

  const options: { label: string; text: string; run: () => void; primary?: boolean }[] = [];
  if (mode === "on")
    options.push({
      label: "Pause",
      text: "Autonomous tasks pause after their current turn. Resume restarts exactly those.",
      run: () => actions.pause(onClose),
    });
  if (mode === "paused")
    options.push({
      label: "Resume",
      text: "The captain picks up again, and the tasks the pause held restart.",
      run: () => actions.resume(onClose),
      primary: true,
    });
  if (mode !== "stopping")
    options.push({
      label: "Stop gracefully",
      text: "Current turns finish, nothing new starts, then it turns off.",
      run: () => actions.stop("graceful", onClose),
    });
  options.push({
    label: "Stop now",
    text: "Stops every autonomous run at once.",
    run: () => setConfirmNow(true),
  });

  return (
    <Modal label="Turn off autonomous mode" onClose={onClose} className="w-[440px]">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-md font-semibold">
          {mode === "stopping" ? "Autonomous mode is stopping" : "Turn off autonomous mode"}
        </h2>
        <ul className="flex flex-col gap-2">
          {options.map((option) => (
            <li key={option.label} className="flex items-center gap-3">
              <Button
                variant={option.primary ? "primary" : "secondary"}
                className="w-[132px]"
                disabled={actions.busy}
                onClick={option.run}
              >
                {option.label}
              </Button>
              <span className="text-sm text-fg-muted text-pretty">{option.text}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Keep it {mode === "paused" ? "paused" : "on"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The status bar's controls: Turn on while off; Pause or Resume, and Stop, which offers both stops. */
export function ModeControls({ status }: { status: AutonomyStatus }) {
  const actions = useAutonomyActions();
  const [open, setOpen] = useState<"on" | "stop">();
  const mode = status.mode;
  return (
    <div className="flex shrink-0 items-center gap-2">
      {mode === "off" && (
        <Button variant="primary" onClick={() => setOpen("on")}>
          Turn on
        </Button>
      )}
      {mode === "on" && (
        <Button disabled={actions.busy} onClick={() => actions.pause()}>
          Pause
        </Button>
      )}
      {mode === "paused" && (
        <Button variant="primary" disabled={actions.busy} onClick={() => actions.resume()}>
          Resume
        </Button>
      )}
      {mode !== "off" && (
        <Button disabled={actions.busy} onClick={() => setOpen("stop")}>
          Stop
        </Button>
      )}
      {open === "on" && <TurnOnDialog status={status} onClose={() => setOpen(undefined)} />}
      {open === "stop" && <OffDialog mode={mode} onClose={() => setOpen(undefined)} />}
    </div>
  );
}
