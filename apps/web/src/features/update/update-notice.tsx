import { ArrowUpCircle, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { CommandLine } from "@/components/command-line";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS_STRONG } from "@/lib/glass";
import { useStartUpdate, useSystemVersion } from "@/lib/ops-queries";
import { changeSummary, updateNotice, workingText } from "./model";
import { beginUpdateSession, useUpdateSession } from "./session";

/**
 * "Update ready", one row above the agents' lamps so it never pushes the navigation out of view. The
 * button rebuilds majhi; the arrow opens a panel above the row with the list of changes and any notes.
 */
export function UpdateNotice() {
  // While an update waits for the agents, look often so the "Updating majhi" screen opens in time.
  const [scheduledAt, setScheduledAt] = useState<string>();
  const version = useSystemVersion(scheduledAt === undefined ? 60_000 : 3_000);
  const start = useStartUpdate();
  const session = useUpdateSession();
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState<string>();
  const notice = updateNotice(version.data);
  const began = version.data?.update;

  // The server started the update it was waiting with: show its progress.
  useEffect(() => {
    if (scheduledAt === undefined || began === undefined) return;
    if (Date.parse(began.startedAt) >= Date.parse(scheduledAt) - 2_000) {
      setScheduledAt(undefined);
      beginUpdateSession(scheduledAt);
    }
  }, [began, scheduledAt]);

  if (notice.kind === "none" || session !== undefined) return null;

  async function update(when: "now" | "idle") {
    const startedAt = new Date().toISOString();
    try {
      const out = await start.mutateAsync(when);
      if (out.state === "restarting") beginUpdateSession(startedAt);
      else if (out.state === "waiting") setScheduledAt(startedAt);
      else setManual(out.reason ?? "majhi cannot update itself from here.");
    } catch {
      // The error shows in the panel.
    }
  }

  const manualOnly = manual !== undefined || !notice.canUpdate;
  const waiting = notice.waiting || scheduledAt !== undefined;
  // With agents working the choice (wait for them, or go now) is in the panel; otherwise one click updates.
  const direct = notice.working === 0 && !waiting;
  const showPanel = open || start.error !== null || manualOnly;
  return (
    <section aria-label="Update ready" className="relative shrink-0">
      <div className="flex h-9 items-center gap-1 rounded-lg border border-amber-line bg-amber-wash pr-1 pl-1">
        <button
          type="button"
          aria-expanded={open}
          title={`${changeSummary(notice.changes)}. Show what changed`}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-amber-soft"
        >
          <ArrowUpCircle aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Update ready</span>
          <span className="sr-only">{changeSummary(notice.changes)}</span>
        </button>
        {!manualOnly && direct && (
          <Button variant="primary" size="sm" disabled={start.isPending} onClick={() => void update("now")}>
            {start.isPending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {start.isPending ? "Starting" : "Update"}
          </Button>
        )}
        {!manualOnly && !direct && (
          <Button size="sm" onClick={() => setOpen(true)}>
            {waiting ? "Waiting" : "Update"}
          </Button>
        )}
      </div>
      {showPanel && (
        <div
          className={cn(
            "absolute bottom-full left-0 z-30 mb-2 flex w-[280px] max-w-[calc(100vw-24px)] flex-col gap-2 rounded-lg border border-amber-line p-3 shadow-lg",
            GLASS_STRONG,
          )}
        >
          <p className="text-xs font-medium text-fg">{changeSummary(notice.changes)}</p>
          {notice.changes.length > 0 && (
            <ul
              aria-label="Changes"
              className="flex max-h-40 flex-col gap-1 overflow-y-auto text-xs text-fg-soft"
            >
              {notice.changes.map((change) => (
                <li key={change} className="text-pretty">
                  {change}
                </li>
              ))}
            </ul>
          )}
          {notice.dirty && (
            <p className="text-xs text-fg-muted text-pretty">
              The majhi folder has changes you have not committed. The update includes them.
            </p>
          )}
          {manualOnly ? (
            <>
              <p className="text-xs text-fg-muted text-pretty">
                {manual ?? "The host helper is not connected, so majhi cannot rebuild itself from here."} Run
                this in the majhi folder:
              </p>
              <CommandLine command="make up" />
            </>
          ) : (
            !direct && (
              <UpdateButtons
                working={notice.working}
                waiting={waiting}
                pending={start.isPending}
                onUpdate={(when) => void update(when)}
              />
            )
          )}
          {start.error && (
            <p role="alert" className="text-xs text-red">
              {describeError(start.error)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Agents are working: the panel says how many and offers to wait for them; their turns resume on
 * their own after the restart either way.
 */
function UpdateButtons({
  working,
  waiting,
  pending,
  onUpdate,
}: {
  working: number;
  waiting: boolean;
  pending: boolean;
  onUpdate: (when: "now" | "idle") => void;
}) {
  return (
    <>
      <p className="text-xs text-fg-muted text-pretty">
        {waiting
          ? "majhi updates as soon as the agents finish their turns."
          : `${workingText(working)} Their turns continue on their own after the update.`}
      </p>
      <div className="flex flex-wrap gap-2">
        {!waiting && (
          <Button variant="primary" size="sm" disabled={pending} onClick={() => onUpdate("idle")}>
            Update when they finish
          </Button>
        )}
        <Button size="sm" disabled={pending} onClick={() => onUpdate("now")}>
          Update now
        </Button>
      </div>
    </>
  );
}
