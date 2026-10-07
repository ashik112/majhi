import type { WikiClaim, WikiPage, WikiSource } from "@majhi/shared";
import { ChevronRight, FileText } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { type Cites, Markdown } from "@/features/room/markdown";
import { cn } from "@/lib/cn";
import { COPY } from "./copy";
import { baseName, leadOf } from "./model";

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
      title={proven ? COPY.basis.provenTitle : COPY.basis.guessedTitle}
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
      {proven ? COPY.basis.proven : COPY.basis.guessed}
    </span>
  );
}

/** The amber dot and words of a page or a source that a newer commit may have outdated. */
export function StaleMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-fg-faint", className)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-amber" />
      {COPY.subline.outOfDate}
    </span>
  );
}

/** The red dot and words of a page the last update could not write. */
export function FailedMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-red", className)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-red" />
      {COPY.failed.mark}
    </span>
  );
}

/** The chips of a claim's sources. A guess with none says so. */
export function Sources({
  claim,
  changed,
  onOpen,
}: {
  claim: WikiClaim;
  changed: ReadonlySet<string>;
  onOpen: OpenSource;
}) {
  if (claim.sources.length === 0) return <span className="text-xs text-fg-faint">{COPY.basis.noFile}</span>;
  return (
    <>
      {claim.sources.map((s) => (
        <SourceChip
          key={`${s.repo}:${s.path}:${s.lines[0]}-${s.lines[1]}`}
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

/** A page's own sentence: Markdown, so a `code` name is drawn as code and never as raw backticks. */
export function Text({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("min-w-0 text-body text-pretty", className)}>
      <Markdown text={children} size="inline" />
    </div>
  );
}

/**
 * One section of a page: a hairline above, a 15px heading and the content. The first has no hairline. A
 * heading never has a line of help under it; `note` is a count in the same row.
 */
export function Block({
  title,
  first = false,
  note,
  children,
  className,
}: {
  title: string;
  first?: boolean;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn("flex min-w-0 flex-col gap-3 pt-4 pb-5", first ? "" : "border-t border-line", className)}
    >
      <div className="flex min-h-7 items-center gap-3">
        <h3 className="text-md font-semibold text-fg">{title}</h3>
        {note !== undefined && <span className="tnum min-w-0 text-sm text-fg-faint">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/** A section that starts closed: its heading and a count, and the content once opened. */
export function Fold({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 border-t border-line pt-3 pb-5">
      <details className="group">
        <summary className="flex min-h-7 cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-fg-faint transition-transform duration-150 group-open:rotate-90"
          />
          <h3 className="text-md font-semibold text-fg">{title}</h3>
          {note !== undefined && <span className="tnum text-sm text-fg-faint">{note}</span>}
        </summary>
        <div className="pt-3">{children}</div>
      </details>
    </section>
  );
}

/** The page's own text, with `[n]` turned into a button that opens claim n's first source. */
export function BodyText({
  page,
  onOpen,
  leadOnly = false,
}: {
  page: WikiPage;
  onOpen: OpenSource;
  /** Only the opening, not the lists after it (those are drawn from the page's claims). */
  leadOnly?: boolean;
}) {
  const cites = useMemo<Cites>(() => {
    const byNumber = new Map(page.claims.map((c) => [c.n, c]));
    return {
      known: new Set(byNumber.keys()),
      render: (n) => <CiteButton n={n} claim={byNumber.get(n)} onOpen={onOpen} />,
    };
  }, [page.claims, onOpen]);
  const text = leadOnly ? leadOf(page.body) : page.body;
  if (text.trim() === "") return null;
  return (
    <div className="min-w-0 max-w-[68ch] text-pretty">
      <Markdown text={text} size="inline" cites={cites} />
    </div>
  );
}

function CiteButton({ n, claim, onOpen }: { n: number; claim: WikiClaim | undefined; onOpen: OpenSource }) {
  const source = claim?.sources[0];
  const name = source === undefined ? COPY.basis.noFile : `${source.path}:${source.lines[0]}`;
  const style =
    "mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-sm border px-1 align-baseline font-mono text-[10px] leading-none";
  if (source === undefined) {
    return (
      <span title={name} className={cn(style, "border-dashed border-amber-line text-amber")}>
        {n}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={name}
      data-cite={n}
      onClick={() => onOpen(source)}
      className={cn(
        style,
        "cursor-pointer text-fg-soft hover:bg-raised hover:text-fg",
        claim?.proven === false ? "border-dashed border-amber-line" : "border-line-control",
      )}
    >
      {n}
    </button>
  );
}
