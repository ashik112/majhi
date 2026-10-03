import { TRACKER_LABEL } from "@majhi/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { useTrackerLink } from "@/lib/tracker-queries";

/** The tracker item a task is linked to, opening it. Red when the last write-back failed. */
export function TrackerChip({ task, className }: { task: string; className?: string }) {
  const link = useTrackerLink(task);
  if (link === undefined) return null;
  const label = TRACKER_LABEL[link.type];
  const title = link.error
    ? `${label} ${link.key}: could not update it. ${link.error}`
    : `${label} ${link.key}: ${link.status}`;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      title={title}
      className={cn("relative z-10 shrink-0 rounded-sm", className)}
    >
      <Badge mono tone={link.error ? "red" : "neutral"} className="h-[18px] hover:text-fg">
        {link.key}
      </Badge>
    </a>
  );
}
