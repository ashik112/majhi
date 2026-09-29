import { canWorkIn, type Task } from "@majhi/shared";
import { ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { useAgentIndex } from "@/lib/agent-index";
import { useUpdateTask } from "@/lib/task-queries";

const BUSY_HINT = "Stop the agent first";

/**
 * Gives the task to another agent that can work in its org. The server refuses while an agent of
 * the task is busy, so the control is off then; the room note saying who took over comes from the server.
 */
export function ChangeAgent({ task, busy }: { task: Task; busy: boolean }) {
  const index = useAgentIndex();
  const update = useUpdateTask();
  const toast = useToast();
  const current = task.team[0];

  if (busy) {
    // The span carries the hint: a disabled button gets no pointer events, so no tooltip of its own.
    return (
      <span title={BUSY_HINT} className="shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          aria-label={`Change agent. ${BUSY_HINT}`}
          aria-disabled="true"
        >
          <ArrowRightLeft aria-hidden="true" />
        </Button>
      </span>
    );
  }

  const choices = [...index.values()]
    .filter((a) => canWorkIn(a, task.org))
    .toSorted(
      (a, b) => Number(b.scope === task.org) - Number(a.scope === task.org) || a.id.localeCompare(b.id),
    );
  const items: MenuItem[] = choices.map((a) => ({
    label: `@${a.id} · ${a.role}`,
    checked: a.id === current,
    onSelect: () => {
      if (a.id === current) return;
      update.mutate(
        { id: task.id, agent: a.id },
        { onError: (e) => toast("Could not change the agent", { detail: e.message, tone: "error" }) },
      );
    },
  }));
  if (items.length === 0) {
    items.push({ label: "No agent can work in this org", onSelect: () => {}, disabled: true });
  }

  return (
    <Menu
      label="Change agent"
      items={items}
      trigger={({ ref, ...props }) => (
        <Button
          ref={ref}
          variant="ghost"
          size="icon-sm"
          className="size-7"
          {...props}
          aria-label="Change agent"
          title="Change agent"
          disabled={update.isPending}
        >
          <ArrowRightLeft aria-hidden="true" />
        </Button>
      )}
    />
  );
}
