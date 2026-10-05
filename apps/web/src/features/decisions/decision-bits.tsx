import { DECISION_KIND_LABEL, type OwnerDecision, type OwnerDecisionKind } from "@majhi/shared";
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
  Scale,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { OrgBadge } from "@/components/ui/org-badge";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";
import { useOrgs } from "@/lib/studio-queries";

/** The small parts a decision row shares with the Decisions page. Kept apart so the bell and Home do not load the page's list. */

const ICON: Record<OwnerDecisionKind, ReactNode> = {
  ship: <GitMerge aria-hidden="true" />,
  question: <MessageCircleQuestion aria-hidden="true" />,
  approval: <ShieldCheck aria-hidden="true" />,
  secret: <KeyRound aria-hidden="true" />,
  budget: <CircleDollarSign aria-hidden="true" />,
  paused: <CirclePause aria-hidden="true" />,
  "sign-in": <LogIn aria-hidden="true" />,
  draft: <Mail aria-hidden="true" />,
  batch: <Mails aria-hidden="true" />,
  incident: <BellRing aria-hidden="true" />,
  trust: <Scale aria-hidden="true" />,
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
