import { ArrowUpCircle, ChevronDown, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { CommandLine } from "@/components/command-line";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useStartUpdate, useSystemVersion } from "@/lib/ops-queries";
import { changeSummary, updateNotice } from "./model";
import { beginUpdateSession, useUpdateSession } from "./session";

/** "Update ready", under the logo. Click it for the list of changes; the button rebuilds majhi. */
export function UpdateNotice() {
  const version = useSystemVersion();
  const start = useStartUpdate();
  const session = useUpdateSession();
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState<string>();
  const notice = updateNotice(version.data);
  if (notice.kind === "none" || session !== undefined) return null;

  async function update() {
    const startedAt = new Date().toISOString();
    try {
      const out = await start.mutateAsync();
      if (out.state === "restarting") beginUpdateSession(startedAt);
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
      {notice.dirty && (
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
        <Button variant="primary" size="sm" disabled={start.isPending} onClick={() => void update()}>
          {start.isPending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {start.isPending ? "Starting" : "Update"}
        </Button>
      )}
      {start.error && (
        <p role="alert" className="text-xs text-red">
          {describeError(start.error)}
        </p>
      )}
    </section>
  );
}
