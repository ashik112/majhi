import { ArrowUpCircle, ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { CommandLine } from "@/components/command-line";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useStartUpdate, useSystemVersion } from "@/lib/ops-queries";
import { changeSummary, updateNotice, workingText } from "./model";
import { beginUpdateSession, useUpdateSession } from "./session";

/** "Update ready", under the logo. Click it for the list of changes; the button rebuilds majhi. */
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
      // The error shows under the button.
    }
  }

  const body = manual !== undefined || !notice.canUpdate;
  return (
    <section
      aria-label="Update ready"
      className="flex flex-col gap-2 rounded-lg border border-amber-line bg-amber-wash p-3"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 text-left text-amber-soft"
      >
        <ArrowUpCircle aria-hidden="true" className="size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-medium">Update ready</span>
          <span className="text-xs text-fg-muted">{changeSummary(notice.changes)}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 transition-transform duration-150", open && "rotate-180")}
        />
      </button>
      {open && notice.changes.length > 0 && (
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
      {open && notice.dirty && (
        <p className="text-xs text-fg-muted text-pretty">
          The majhi folder has changes you have not committed. The update includes them.
        </p>
      )}
      {body ? (
        <>
          <p className="text-xs text-fg-muted text-pretty">
            {manual ?? "The host helper is not connected, so majhi cannot rebuild itself from here."} Run this
            in the majhi folder:
          </p>
          <CommandLine command="make up" />
        </>
      ) : (
        <UpdateButtons
          note={open}
          working={notice.working}
          waiting={notice.waiting || scheduledAt !== undefined}
          pending={start.isPending}
          onUpdate={(when) => void update(when)}
        />
      )}
      {start.error && (
        <p role="alert" className="text-xs text-red">
          {describeError(start.error)}
        </p>
      )}
    </section>
  );
}

/**
 * With no agent working, one Update button. Otherwise the card says how many are working and
 * offers to wait for them; their turns resume on their own after the restart either way.
 */
function UpdateButtons({
  note,
  working,
  waiting,
  pending,
  onUpdate,
}: {
  /** The sentence about the working agents; folded away with the change list. */
  note: boolean;
  working: number;
  waiting: boolean;
  pending: boolean;
  onUpdate: (when: "now" | "idle") => void;
}) {
  if (working === 0 && !waiting) {
    return (
      <Button variant="primary" size="sm" disabled={pending} onClick={() => onUpdate("now")}>
        {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
        {pending ? "Starting" : "Update"}
      </Button>
    );
  }
  return (
    <>
      {(note || waiting) && (
        <p className="text-xs text-fg-muted text-pretty">
          {waiting
            ? "majhi updates as soon as the agents finish their turns."
            : `${workingText(working)} Their turns continue on their own after the update.`}
        </p>
      )}
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
