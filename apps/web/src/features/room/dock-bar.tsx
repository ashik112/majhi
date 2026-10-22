import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";

/**
 * One thing that waits for the owner, as a single bar in the Needs you block: a lamp, what it is in bold, one
 * plain line, the buttons, and a chevron (or "Details") that opens the rest. It has no box of its own; the block
 * is the box. Every card kind in the block draws through it.
 */
export function DockBar({
  label,
  lamp,
  title,
  line,
  actions,
  details,
  detailsLabel,
  inline = false,
  id,
  below,
}: {
  /** The section's accessible name. */
  label: string;
  lamp: LampState;
  /** What it is, in a few words: "Ready to ship", "Captain asks". */
  title: ReactNode;
  /** The reason, under the title at full width; it wraps. */
  line?: ReactNode;
  /** Primary and secondary buttons. */
  actions?: ReactNode;
  /** What the chevron opens: the checks, the input, the long reason. */
  details?: ReactNode;
  /** A word for the control that opens `details`, in place of the chevron: "Details". */
  detailsLabel?: string | undefined;
  /** The line follows the title on the same row (an incident's one line) instead of sitting under it. */
  inline?: boolean;
  /** DOM id, for the banner's "Show". */
  id?: string;
  /** Always shown under the bar, like a progress note. */
  below?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      id={id}
      tabIndex={id === undefined ? undefined : -1}
      aria-label={label}
      className="flex min-w-0 flex-col gap-1.5 py-2 outline-none"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-1 basis-[240px] items-start gap-2">
          <Lamp state={lamp} size={8} className="mt-[7px]" />
          <div
            className={cn(
              "flex min-w-0 flex-1",
              inline ? "flex-row flex-wrap items-baseline gap-x-2.5" : "flex-col",
            )}
          >
            <span className="text-base font-semibold break-words text-fg">{title}</span>
            {line !== undefined && <span className="text-sm break-words text-fg">{line}</span>}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          {details !== undefined && detailsLabel !== undefined && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="cursor-pointer rounded-sm px-1 text-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              {detailsLabel} {open ? "▴" : "▾"}
            </button>
          )}
          {actions}
          {details !== undefined && detailsLabel === undefined && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Hide details" : "Show details"}
              title={open ? "Hide details" : "Show details"}
              onClick={() => setOpen((v) => !v)}
              className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
            >
              <ChevronDown
                aria-hidden="true"
                className={cn("size-4 transition-transform duration-150", open && "rotate-180")}
              />
            </button>
          )}
        </div>
      </div>
      {below}
      {open && details !== undefined && (
        <div className="flex min-w-0 flex-col gap-2 pl-4 text-sm text-fg">{details}</div>
      )}
    </section>
  );
}
