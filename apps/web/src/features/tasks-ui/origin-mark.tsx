import type { OriginKind, OriginView } from "@majhi/shared";
import { Anchor, Clock, CornerDownRight, Eye, Focus, type LucideIcon, User } from "lucide-react";
import { cn } from "@/lib/cn";

const ORIGIN_ICON: Record<OriginKind, LucideIcon> = {
  owner: User,
  captain: Anchor,
  finding: Focus,
  watch: Eye,
  schedule: Clock,
  parent: CornerDownRight,
};

/** What each origin is called in the Source filter and next to its icon. */
export const ORIGIN_LABEL: Record<OriginKind, string> = {
  owner: "You",
  captain: "Captain",
  finding: "Finding",
  watch: "Watch",
  schedule: "Schedule",
  parent: "Subtask",
};

export const ORIGIN_KINDS: readonly OriginKind[] = [
  "owner",
  "captain",
  "finding",
  "watch",
  "schedule",
  "parent",
];

export function OriginIcon({ kind, className }: { kind: OriginKind; className?: string }) {
  const Icon = ORIGIN_ICON[kind];
  return <Icon aria-hidden="true" className={cn("size-3.5", className)} />;
}

/** The name to show beside the icon: who or what made the task. */
export function originName(origin: OriginView): string {
  switch (origin.kind) {
    case "owner":
      return ORIGIN_LABEL.owner;
    case "captain":
      return ORIGIN_LABEL.captain;
    case "finding":
      return origin.name ?? ORIGIN_LABEL.finding;
    case "watch":
      return origin.name ?? ORIGIN_LABEL.watch;
    case "schedule":
      return origin.name ?? ORIGIN_LABEL.schedule;
    case "parent":
      return origin.task;
  }
}

/** The hover text: the origin as a sentence. */
export function originTitle(origin: OriginView): string {
  switch (origin.kind) {
    case "owner":
      return "You made it";
    case "captain":
      return `Made by the captain: ${origin.reason}`;
    case "finding":
      return `From a finding: ${originName(origin)}`;
    case "watch":
      return "From a watch incident";
    case "schedule":
      return "From a schedule";
    case "parent":
      return `Subtask of ${origin.task}${origin.name === undefined ? "" : `, ${origin.name}`}`;
  }
}

/**
 * Where a task came from, as its icon, and with its name where there is room. A task made before
 * origins existed has none and draws nothing.
 */
export function OriginMark({
  origin,
  named = false,
  className,
}: {
  origin: OriginView | undefined;
  named?: boolean;
  className?: string;
}) {
  if (origin === undefined) return null;
  return (
    <span
      title={originTitle(origin)}
      className={cn("inline-flex min-w-0 shrink-0 items-center gap-1.5 text-fg-faint", className)}
    >
      <OriginIcon kind={origin.kind} />
      {named && <span className="min-w-0 truncate text-xs text-fg-muted">{originName(origin)}</span>}
    </span>
  );
}
