import { AUTO, type OptionValue, type Task } from "@majhi/shared";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { useAccountModels } from "@/lib/studio-queries";
import { useTeamCommand } from "@/lib/task-queries";

/** Auto needs at least two values to pick from, like the server's picker. */
function withAuto(offered: readonly OptionValue[]): { id: string; name: string }[] {
  const list = offered.map((o) => ({ id: o.id, name: o.name || o.id }));
  return offered.length >= 2 ? [{ id: AUTO, name: "Auto" }, ...list] : list;
}

function nameOf(list: readonly { id: string; name: string }[], id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  return list.find((o) => o.id === id)?.name ?? id;
}

/**
 * The model and effort of the agent the composer talks to, for this task only (`team.set`). The
 * choices are what the agent's account offers over ACP. Picking the agent's own value clears the
 * override. A change applies from the agent's next turn.
 */
export function ModelPicker({ task, agent, className }: { task: Task; agent: string; className?: string }) {
  const info = useAgentIndex().get(agent);
  const offered = useAccountModels(info?.account).data;
  const set = useTeamCommand("team.set");
  const toast = useToast();
  if (info === undefined || offered === undefined) return null;
  const models = withAuto(offered.models);
  const efforts = withAuto(offered.efforts);
  if (models.length === 0 && efforts.length === 0) return null;

  const override = task.overrides[agent] ?? {};
  const model = override.model ?? info.model ?? offered.defaultModel;
  const effort = override.effort ?? info.effort ?? offered.defaultEffort;
  const fail = (what: string) => (e: Error) => toast(what, { detail: e.message, tone: "error" });
  const pick = (key: "model" | "effort", id: string, current: string | undefined) => {
    if (id === current) return;
    // The agent's own value needs no override.
    const value = id === info[key] ? null : id;
    if (key === "model")
      set.mutate({ task: task.id, agent, model: value }, { onError: fail("Could not change the model") });
    else
      set.mutate({ task: task.id, agent, effort: value }, { onError: fail("Could not change the effort") });
  };

  const items: MenuItem[] = [
    ...models.map((m) => ({
      group: "Model",
      label: m.name,
      checked: m.id === model,
      onSelect: () => pick("model", m.id, model),
    })),
    ...efforts.map((e) => ({
      group: "Effort",
      label: e.name,
      checked: e.id === effort,
      onSelect: () => pick("effort", e.id, effort),
    })),
  ];
  const label = [nameOf(models, model), nameOf(efforts, effort)].filter(Boolean).join(" · ");

  return (
    <Menu
      label={`Model and effort of @${agent} in this ${task.kind === "chat" ? "chat" : "task"}`}
      items={items}
      maxHeight={480}
      trigger={({ ref, ...props }) => (
        <Button
          ref={ref}
          variant="ghost"
          {...props}
          aria-label={`Model and effort: ${label || "default"}`}
          disabled={set.isPending}
          title={`@${agent} in this ${task.kind === "chat" ? "chat" : "task"}. A change applies from its next turn.`}
          className={cn("h-8 max-w-44 gap-1 px-2 text-sm font-normal", className)}
        >
          <span className="min-w-0 truncate">{label || "Model"}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 text-fg-faint" />
        </Button>
      )}
    />
  );
}
