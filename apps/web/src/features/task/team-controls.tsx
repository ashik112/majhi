import { type CoordinationMode, canWorkIn, MODE_LABELS, type Task } from "@majhi/shared";
import { ChevronDown, Ellipsis, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { useAgentIndex } from "@/lib/agent-index";
import { useAccountModels } from "@/lib/studio-queries";
import { useTeamCommand, useUpdateTask } from "@/lib/task-queries";

const MODES: CoordinationMode[] = ["lead", "pipeline", "review-loop"];

/** Agents that may join the task and are not on it yet, the org's own first. */
function useCandidates(task: Task) {
  const index = useAgentIndex();
  return [...index.values()]
    .filter((a) => canWorkIn(a, task.org) && !task.team.includes(a.id))
    .toSorted(
      (a, b) => Number(b.scope === task.org) - Number(a.scope === task.org) || a.id.localeCompare(b.id),
    );
}

/** How the team takes turns (5.3): Lead delegates, Pipeline, Build and review loop. */
export function ModePicker({ task }: { task: Task }) {
  const update = useUpdateTask();
  const toast = useToast();
  const items: MenuItem[] = MODES.map((mode) => ({
    label: MODE_LABELS[mode],
    checked: mode === task.mode,
    onSelect: () => {
      if (mode === task.mode) return;
      update.mutate(
        { id: task.id, mode },
        { onError: (e) => toast("Could not change the mode", { detail: e.message, tone: "error" }) },
      );
    },
  }));
  return (
    <Menu
      label="Coordination mode"
      items={items}
      align="left"
      trigger={({ ref, ...props }) => (
        <Button
          ref={ref}
          variant="ghost"
          size="sm"
          className="-ml-1.5 h-6 gap-1 px-1.5 text-xs text-fg-muted"
          {...props}
          aria-label={`Coordination mode: ${MODE_LABELS[task.mode]}`}
          disabled={update.isPending}
        >
          {MODE_LABELS[task.mode]}
          <ChevronDown aria-hidden="true" className="size-3" />
        </Button>
      )}
    />
  );
}

/** Adds an agent that may work in the task's org. */
export function AddAgent({ task }: { task: Task }) {
  const add = useTeamCommand("team.add");
  const toast = useToast();
  const candidates = useCandidates(task);
  const items: MenuItem[] = candidates.map((a) => ({
    label: `@${a.id} · ${a.role}`,
    onSelect: () =>
      add.mutate(
        { task: task.id, agent: a.id },
        { onError: (e) => toast("Could not add the agent", { detail: e.message, tone: "error" }) },
      ),
  }));
  if (items.length === 0)
    items.push({ label: "Every agent that can work here is on it", onSelect: () => {}, disabled: true });
  return (
    <Menu
      label="Add agent"
      items={items}
      trigger={({ ref, ...props }) => (
        <Button
          ref={ref}
          variant="ghost"
          size="icon-sm"
          className="size-7"
          {...props}
          aria-label="Add agent"
          title="Add agent"
          disabled={add.isPending}
        >
          <UserPlus aria-hidden="true" />
        </Button>
      )}
    />
  );
}

/**
 * One team member's actions: make it the lead, swap it for another agent, pick its model and
 * effort for this task only, or take it off the task.
 */
export function MemberMenu({ task, id }: { task: Task; id: string }) {
  const index = useAgentIndex();
  const info = index.get(id);
  const models = useAccountModels(info?.account).data;
  const addTeam = useTeamCommand("team.add");
  const swap = useTeamCommand("team.swap");
  const remove = useTeamCommand("team.remove");
  const set = useTeamCommand("team.set");
  const toast = useToast();
  const candidates = useCandidates(task);
  const override = task.overrides[id] ?? {};
  const fail = (what: string) => (e: Error) => toast(what, { detail: e.message, tone: "error" });
  const pending = addTeam.isPending || swap.isPending || remove.isPending || set.isPending;

  const items: MenuItem[] = [];
  if (task.team[0] !== id) {
    items.push({
      label: "Make lead",
      onSelect: () =>
        addTeam.mutate(
          { task: task.id, agent: id, lead: true },
          { onError: fail("Could not change the lead") },
        ),
    });
  }
  const model = override.model ?? info?.model;
  for (const m of models?.models ?? []) {
    items.push({
      label: `Model: ${m.name ?? m.id}`,
      checked: m.id === model,
      onSelect: () =>
        set.mutate(
          { task: task.id, agent: id, model: m.id === info?.model ? null : m.id },
          { onError: fail("Could not change the model") },
        ),
    });
  }
  const effort = override.effort ?? info?.effort;
  for (const e of models?.efforts ?? []) {
    items.push({
      label: `Effort: ${e.name ?? e.id}`,
      checked: e.id === effort,
      onSelect: () =>
        set.mutate(
          { task: task.id, agent: id, effort: e.id === info?.effort ? null : e.id },
          { onError: fail("Could not change the effort") },
        ),
    });
  }
  for (const c of candidates) {
    items.push({
      label: `Swap for @${c.id} · ${c.role}`,
      onSelect: () =>
        swap.mutate({ task: task.id, agent: id, with: c.id }, { onError: fail("Could not swap the agent") }),
    });
  }
  items.push({
    label: "Remove from task",
    tone: "danger",
    disabled: task.team.length < 2,
    onSelect: () =>
      remove.mutate({ task: task.id, agent: id }, { onError: fail("Could not remove the agent") }),
  });

  return (
    <Menu
      label={`@${id} in this task`}
      items={items}
      trigger={({ ref, ...props }) => (
        <Button
          ref={ref}
          variant="ghost"
          size="icon-sm"
          className="size-7"
          {...props}
          aria-label={`@${id} in this task`}
          title="Team, model and effort"
          disabled={pending}
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      )}
    />
  );
}
