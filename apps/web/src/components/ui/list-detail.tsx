import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/**
 * The list-and-detail frame of the Agents, Orgs and Health pages: a glass list on the left and the
 * picked item on the right, both as tall as the page. Each side scrolls inside itself and fades at
 * its edges; the page never scrolls.
 */
export function ListDetail({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-h-0 min-w-0 flex-1 gap-3", className)}>{children}</div>;
}

/** The list side. `footer` stays pinned under the scrolling rows (a "New org" button). */
export function ListPane({
  label,
  footer,
  scrollRef,
  children,
  className,
}: {
  label: string;
  footer?: ReactNode;
  /** The scrolling element, for a list that renders only the rows on screen. */
  scrollRef?: Ref<HTMLDivElement>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "flex w-[264px] shrink-0 flex-col overflow-hidden rounded-2xl min-[1320px]:w-[296px]",
        GLASS,
        className,
      )}
    >
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-6 scroll-fade"
      >
        {children}
      </div>
      {footer && <div className="shrink-0 border-t border-line p-2">{footer}</div>}
    </nav>
  );
}

/** The detail side: a fixed head (name and actions) over a body that scrolls. */
export function DetailPane({
  label,
  head,
  children,
  className,
}: {
  label: string;
  head?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn("flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl", GLASS, className)}
    >
      {head && <div className="shrink-0 border-b border-line px-5 py-3.5">{head}</div>}
      <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-8 scroll-fade">
        {children}
      </div>
    </section>
  );
}

/**
 * One section of a detail pane: a title row with its own actions, then the content. Sections are
 * divided by a hairline, never boxed, so the pane holds no cards inside its glass.
 */
export function DetailSection({
  title,
  note,
  actions,
  children,
  className,
}: {
  title: string;
  /** A short line after the title, in the muted color. */
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn("flex min-w-0 flex-col gap-3 border-t border-line pt-4 pb-5", className)}
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-fg">{title}</h3>
        {note && <span className="min-w-0 text-sm text-fg-faint">{note}</span>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * The selected row, in lists and in the sidebar: the selected tint, a 1px inset ring all around and
 * full text, like a pressed segment. Never an edge bar.
 */
export const ROW_SELECTED = "bg-selected text-fg shadow-[inset_0_0_0_1px_var(--c-line-control)]";

/** A list row at rest: muted until hovered. */
export const ROW =
  "relative flex w-full cursor-pointer rounded-md text-left transition-colors duration-150 hover:bg-raised";
