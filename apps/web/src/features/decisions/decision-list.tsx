import { DECISION_KIND_LABEL, type OwnerDecision, type OwnerDecisionKind } from "@majhi/shared";
import {
  CircleDollarSign,
  CirclePause,
  GitMerge,
  KeyRound,
  LogIn,
  MessageCircleQuestion,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
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

/** What a ship decision is, in the queue: "Ready for review" differs from "Ready to ship". */
export function kindWord(decision: OwnerDecision): string {
  if (decision.kind === "ship" && decision.title.startsWith("Ready for review")) return "Review";
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

/**
 * The queue: two lines per decision. The title first (the task's, not "Ready to ship"), then what
 * kind it is, whose it is, and the captain's pick as a chip. The selected row follows ROW_SELECTED.
 */
export function DecisionList({
  decisions,
  selected,
  now,
  onSelect,
}: {
  decisions: readonly OwnerDecision[];
  selected: string | undefined;
  now: number;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {decisions.map((d) => {
        const workspace = workspaceOf(d);
        const pick = suggestedLabel(d);
        const on = d.id === selected;
        return (
          <li key={d.id}>
            <button
              type="button"
              data-decision={d.id}
              aria-current={on ? "true" : undefined}
              onClick={() => onSelect(d.id)}
              className={cn(ROW, "min-w-0 flex-col gap-1 px-2.5 py-2", on && ROW_SELECTED)}
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
                {pick !== undefined && (
                  <span
                    title={`Captain recommends ${pick}`}
                    className="ml-auto max-w-[45%] shrink-0 truncate rounded-sm border border-accent-line bg-accent-wash px-1.5 py-px text-accent-text"
                  >
                    Captain: {pick}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
