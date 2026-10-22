import type { AgentLive, RoomItem, Task } from "@majhi/shared";
import { useState } from "react";
import { TabBar } from "@/components/ui/tab-bar";
import { TaskMemory } from "@/features/memory/task-memory";
import { Brief } from "./brief";
import { ContextTab } from "./context-tab";
import { TaskLinks } from "./task-links";

/** The goal in one line: the first paragraph of the brief, else the title. */
function goalOf(task: Pick<Task, "title" | "typing">, brief: string): string {
  // An incident's brief is what majhi gathered, not what it is for: its title says what is wrong.
  if (task.typing?.type === "incident") return `Restore service: ${task.title}`;
  const first = brief.split("\n\n")[0]?.trim() ?? "";
  const line = (first === "" ? task.title : first)
    .split("\n")
    .map((s) => s.trim())
    .join(" ");
  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

type Part = "context" | "memory";

/**
 * What the task is for: its goal, the description the owner wrote (Edit changes it), the links to its
 * parent and what it waits for, then Context (how full each agent's context is) and Memory (what was kept).
 */
export function BriefTab({
  task,
  brief,
  agents,
  items,
  memory,
}: {
  task: Task;
  /** What the owner wrote beyond the title. */
  brief: string;
  agents: readonly AgentLive[];
  items: readonly RoomItem[];
  /** The task has a Memory part: it is done, it has lessons, or it has a record. */
  memory: boolean;
}) {
  const [part, setPart] = useState<Part>("context");
  const shown: Part = part === "memory" && !memory ? "context" : part;
  return (
    <div className="@container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pr-1 pb-3 scroll-fade">
      <section aria-label="Goal" className="flex max-w-[96ch] flex-col gap-1">
        <h2 className="text-xs font-medium tracking-[0.08em] text-fg-faint uppercase">Goal</h2>
        <p className="m-0 text-base text-fg">{goalOf(task, brief)}</p>
      </section>
      <section aria-label="Description" className="flex flex-col gap-1">
        <h2 className="text-xs font-medium tracking-[0.08em] text-fg-faint uppercase">Description</h2>
        <Brief key={brief} text={brief} task={task} startOpen />
      </section>
      <section aria-label="Links" className="flex flex-col gap-1">
        <h2 className="text-xs font-medium tracking-[0.08em] text-fg-faint uppercase">Links</h2>
        <div className="flex">
          <TaskLinks task={task} />
        </div>
      </section>
      {memory && (
        <TabBar
          label="Brief parts"
          tabs={[
            { id: "context", label: "Context" },
            { id: "memory", label: "Memory" },
          ]}
          value={shown}
          onChange={setPart}
        />
      )}
      <div className="shrink-0">
        {shown === "context" ? (
          <ContextTab task={task} agents={agents} items={items} />
        ) : (
          <TaskMemory task={task} />
        )}
      </div>
    </div>
  );
}
