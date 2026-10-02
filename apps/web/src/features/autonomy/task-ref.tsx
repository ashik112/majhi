import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn";

/** A task id that opens the task's room, scrolled to `item` when there is one. */
export function TaskRef({
  task,
  item,
  className,
}: {
  task: string;
  item?: string | undefined;
  className?: string;
}) {
  return (
    <Link
      to="/t/$taskId"
      params={{ taskId: task }}
      search={item === undefined ? {} : { item }}
      title={item === undefined ? `Open ${task}` : `Open ${task} at this card`}
      className={cn(
        "shrink-0 rounded-xs font-mono text-xs text-blue underline-offset-2 hover:underline",
        className,
      )}
    >
      {task}
    </Link>
  );
}
