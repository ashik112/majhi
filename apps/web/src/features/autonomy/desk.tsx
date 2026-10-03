import type { TaskSize } from "@majhi/shared";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { useAutonomyCommand } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { SIZE_WORD } from "./model";

/** A section of a panel: its title, a count in mono, and a note or action at the right. */
export function SectionHead({
  title,
  count,
  children,
  className,
}: {
  title: string;
  count?: number | undefined;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-7 items-center gap-2", className)}>
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {count !== undefined && <span className="tnum font-mono text-sm text-fg-faint">{count}</span>}
      {children && <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div>}
    </div>
  );
}

export function SizeBadge({ size, note }: { size: TaskSize | undefined; note?: string | undefined }) {
  if (size === undefined)
    return (
      <span title={note} className="shrink-0 text-xs text-fg-faint">
        size ?
      </span>
    );
  return (
    <Badge tone={size === "large" ? "amber" : "neutral"} title={note}>
      {SIZE_WORD[size]}
    </Badge>
  );
}

/** Marks a task as one the captain leaves alone, or clears the mark, with a toast either way. */
export function useExclude() {
  const toast = useToast();
  const exclude = useAutonomyCommand("autonomy.exclude");
  return {
    busy: exclude.isPending,
    set: (task: string, on: boolean) =>
      exclude.mutate(
        {
          input: { task, exclude: on },
          reason: on ? `Owner told the captain to leave ${task} alone` : `Owner let the captain take ${task}`,
        },
        {
          onSuccess: () =>
            on
              ? toast(`${task} is left alone`, {
                  detail: "The captain will not start, message or change it.",
                })
              : toast(`The captain may take ${task} again`),
          onError: (error) => toast("Could not change it", { detail: describeError(error), tone: "error" }),
        },
      ),
  };
}
