import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { AgentRef } from "@/features/agent-drawer/agent-ref";
import { splitMentions, splitTaskRefs } from "@/features/room/task-refs";
import { useAgentIndex } from "@/lib/agent-index";
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

/** Plain message text with the task ids and agent mentions in it as links. */
export function TaskRefText({ text }: { text: string }) {
  const known = useTaskIds();
  const index = useAgentIndex();
  const parts = useMemo(() => {
    const agents = new Set(index.keys());
    return splitMentions(text, agents).flatMap((piece): (string | { id: string } | { agent: string })[] =>
      typeof piece === "string" ? splitTaskRefs(piece, known) : [piece],
    );
  }, [text, known, index]);
  return parts.map((part, i) =>
    typeof part === "string" ? (
      part
    ) : "agent" in part ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text keep their order
      <AgentRef key={i} id={part.agent} />
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text keep their order
      <TaskRef key={i} id={part.id} />
    ),
  );
}
