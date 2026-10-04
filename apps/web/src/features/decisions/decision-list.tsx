import { DECISION_KIND_LABEL, type OwnerDecision, type OwnerDecisionKind } from "@majhi/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BellRing,
  CircleDollarSign,
  CirclePause,
  GitMerge,
  KeyRound,
  LogIn,
  Mail,
  Mails,
  MessageCircleQuestion,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { cn } from "@/lib/cn";
import { badgeLetters, formatAgo } from "@/lib/format";
import { useOrgs } from "@/lib/studio-queries";
import { rowTitle, suggestedLabel, workspaceOf } from "./model";

const ICON: Record<OwnerDecisionKind, ReactNode> = {
  ship: <GitMerge aria-hidden="true" />,
  question: <MessageCircleQuestion aria-hidden="true" />,
  approval: <ShieldCheck aria-hidden="true" />,
  secret: <KeyRound aria-hidden="true" />,
  budget: <CircleDollarSign aria-hidden="true" />,
  cap: <CircleDollarSign aria-hidden="true" />,
  paused: <CirclePause aria-hidden="true" />,
  "sign-in": <LogIn aria-hidden="true" />,
  draft: <Mail aria-hidden="true" />,
  batch: <Mails aria-hidden="true" />,
  incident: <BellRing aria-hidden="true" />,
};

export function KindIcon({ kind, className }: { kind: OwnerDecisionKind; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center text-fg-muted [&_svg]:size-4",
        className,
      )}
    >
      {ICON[kind]}
    </span>
  );
}

/** What a decision is, in the queue: the shared word for its kind. */
export function kindWord(decision: OwnerDecision): string {
  return DECISION_KIND_LABEL[decision.kind];
}

/** The workspace's tile and name. The name is cut when the line is short. */
export function WorkspaceName({ id, className }: { id: string; className?: string }) {
  const org = useOrgs().data?.find((o) => o.id === id);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <OrgBadge label={badgeLetters(org?.key ?? id)} color={org?.color} size="xs" />
      <span className="min-w-0 truncate">{org?.name ?? id}</span>
    </span>
  );
}

const ROW_ESTIMATE = 62;

/**
 * The queue: two lines per decision, with a checkbox for batches. The title first (the task's, not the
 * kind), then what kind it is, whose it is, and the captain's pick as a chip. The selected row follows
 * ROW_SELECTED. Only the rows on screen are drawn, so 500 decisions stay fast.
 */
export function DecisionList({
  decisions,
  selected,
  now,
  scroller,
  picked,
  held,
  onSelect,
  onPick,
}: {
  decisions: readonly OwnerDecision[];
  selected: string | undefined;
  now: number;
  /** The element the queue scrolls in. */
  scroller: HTMLElement | null;
  picked: ReadonlySet<string>;
  /** Decisions in a batch that waits out its undo time. */
  held: ReadonlySet<string>;
  onSelect: (id: string) => void;
  /** The checkbox: `range` when shift was held. */
  onPick: (id: string, range: boolean) => void;
}) {
  const virtual = useVirtualizer({
    count: decisions.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 10,
    getItemKey: (i) => decisions[i]?.id ?? i,
  });
  const at = decisions.findIndex((d) => d.id === selected);
  // The keys move the selection: keep it in view.
  useEffect(() => {
    if (at >= 0) virtual.scrollToIndex(at, { align: "auto" });
  }, [at, virtual]);

  return (
    <ul
      className="relative m-0 list-none p-0"
      style={{ height: virtual.getTotalSize() }}
      aria-label={`${decisions.length} decisions`}
    >
      {virtual.getVirtualItems().map((row) => {
        const d = decisions[row.index];
        if (d === undefined) return null;
        const workspace = workspaceOf(d);
        const pick = suggestedLabel(d);
        const on = d.id === selected;
        const isHeld = held.has(d.id);
        const checked = picked.has(d.id) || isHeld;
        return (
          <li
            key={d.id}
            ref={virtual.measureElement}
            data-index={row.index}
            className={cn(
              "absolute inset-x-0 top-0 flex items-stretch gap-0.5 pb-0.5",
              isHeld && "opacity-55",
            )}
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <label className="flex w-7 shrink-0 cursor-pointer items-start justify-center pt-3">
              <input
                type="checkbox"
                checked={checked}
                disabled={isHeld}
                aria-label={`Select ${rowTitle(d)}`}
                onClick={(e) => onPick(d.id, e.shiftKey)}
                onChange={() => undefined}
                className="size-4 cursor-pointer accent-[var(--c-accent)]"
              />
            </label>
            <button
              type="button"
              data-decision={d.id}
              aria-current={on ? "true" : undefined}
              onClick={() => onSelect(d.id)}
              className={cn(ROW, "min-w-0 flex-1 flex-col gap-1 px-2 py-2", on && ROW_SELECTED)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <KindIcon kind={d.kind} />
                <span className={cn("min-w-0 flex-1 truncate text-base text-fg", on && "font-medium")}>
                  {rowTitle(d)}
                </span>
                <span className="tnum shrink-0 font-mono text-xs text-fg-faint">{formatAgo(d.at, now)}</span>
              </span>
              <span className="flex min-w-0 items-center gap-2 pl-6 text-xs text-fg-faint">
                <span className="shrink-0">{kindWord(d)}</span>
                {workspace !== undefined && (
                  <WorkspaceName id={workspace} className="max-w-[45%] text-fg-muted" />
                )}
                {isHeld ? (
                  <span className="ml-auto shrink-0 text-fg-muted">Waiting to be sent</span>
                ) : (
                  pick !== undefined && (
                    <span
                      title={`Captain recommends ${pick}`}
                      className="ml-auto max-w-[45%] shrink-0 truncate rounded-sm border border-accent-line bg-accent-wash px-1.5 py-px text-accent-text"
                    >
                      Captain: {pick}
                    </span>
                  )
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
