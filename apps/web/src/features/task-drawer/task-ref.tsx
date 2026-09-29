import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { splitTaskRefs } from "@/features/room/task-refs";
import { useTaskIds, useTasks } from "@/lib/task-queries";
import type { AppSearch } from "@/router";

/** A task id that opens the task in the drawer (`?task=`), over whatever page is open. */
export function TaskRef({ id, children }: { id: string; children?: ReactNode }) {
  const title = useTasks().data?.find((t) => t.id === id)?.title;
  return (
    <Link
      to="."
      search={(prev: AppSearch) => ({ ...prev, task: id })}
      title={title ? `${id}: ${title}` : id}
      className="md-link font-mono"
    >
      {children ?? id}
    </Link>
  );
}

/** Plain message text with the task ids in it as links. */
export function TaskRefText({ text }: { text: string }) {
  const known = useTaskIds();
  const parts = useMemo(() => splitTaskRefs(text, known), [text, known]);
  return parts.map((part, i) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text keep their order
    typeof part === "string" ? part : <TaskRef key={i} id={part.id} />,
  );
}
