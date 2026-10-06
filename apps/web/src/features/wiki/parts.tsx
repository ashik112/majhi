import type { WikiClaim, WikiSource } from "@majhi/shared";
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { baseName } from "./model";

/** What the page does with a source: open it in the viewer. The view keeps the open one. */
export type OpenSource = (source: WikiSource) => void;

/** `file.py:120`: opens the cited lines in the file viewer. An amber dot says a newer commit changed the file. */
export function SourceChip({
  source,
  moved,
  onOpen,
}: {
  source: WikiSource;
  moved: boolean;
  onOpen: OpenSource;
}) {
  const where = `${source.path}:${source.lines[0]}${source.lines[1] === source.lines[0] ? "" : `-${source.lines[1]}`}`;
  return (
    <button
      type="button"
      data-source={where}
      title={moved ? `${where} (changed in a newer commit)` : where}
      onClick={() => onOpen(source)}
      className={cn(
        "inline-flex h-6 max-w-full cursor-pointer items-center gap-1 rounded-md border bg-field px-1.5 font-mono text-xs text-fg-soft",
        "transition-colors duration-150 hover:border-line-hover hover:bg-raised hover:text-fg",
        moved ? "border-amber-line" : "border-line-control",
      )}
    >
      <FileText aria-hidden="true" className="size-3 shrink-0 text-fg-faint" />
      <span className="min-w-0 truncate">
        {baseName(source.path)}:{source.lines[0]}
      </span>
      {moved && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber" />}
    </button>
  );
}

/** Proven: a tool or a checked citation shows it. Guessed: inferred, so no file shows it. The word always sits beside the dot. */
export function BasisMark({ proven, className }: { proven: boolean; className?: string }) {
  return (
    <span
      title={proven ? "Proven: the cited lines show it" : "Guessed: inferred, no file shows it"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs",
        proven ? "text-green" : "text-amber",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", proven ? "bg-green" : "border border-amber")}
      />
      {proven ? "proven" : "guessed"}
    </span>
  );
}

/** The amber dot and words of a page or a source that a newer commit may have outdated. */
export function StaleMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-fg-faint", className)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-amber" />
      out of date
    </span>
  );
}

/** The chips of a claim's sources. A guessed claim with none says so. */
export function Sources({
  claim,
  changed,
  onOpen,
}: {
  claim: WikiClaim;
  changed: ReadonlySet<string>;
  onOpen: OpenSource;
}) {
  if (claim.sources.length === 0) return <span className="text-xs text-fg-faint">no file shows it</span>;
  return (
    <>
      {claim.sources.map((s) => (
        <SourceChip
          key={`${s.path}:${s.lines[0]}-${s.lines[1]}`}
          source={s}
          moved={changed.has(s.path)}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

/** A statistic of a page head: a number in the text color, then its word. */
export function Stat({ value, children }: { value: ReactNode; children: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <b className="font-medium text-fg">{value}</b> {children}
    </span>
  );
}
