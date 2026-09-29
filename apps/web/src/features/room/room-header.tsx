import type { AgentLive, Task } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisVertical, GitBranch, OctagonX, Play, RotateCw } from "lucide-react";
import { useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Menu } from "@/components/ui/menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import type { ApiRequestError } from "@/lib/api";
import { useOrgs } from "@/lib/studio-queries";
import { useCloseTask, useRemoveTask, useStartTask, useStopTask } from "@/lib/task-queries";
import { orgColor, primaryAction } from "../tasks/model";
import { isWorking } from "./model";

const AGENT_STATUS: Record<AgentLive["status"], string> = {
  idle: "idle",
  starting: "starting",
  working: "working",
  waiting: "waiting for you",
  stopped: "stopped",
  error: "error",
};

export function RoomHeader({ task, agents }: { task: Task; agents: readonly AgentLive[] }) {
  const orgs = useOrgs().data ?? [];
  const color = orgColor(orgs, task.org);
  const start = useStartTask();
  const stop = useStopTask();
  const toast = useToast();
  const action = primaryAction(task.status);
  const [confirm, setConfirm] = useState<"close" | "remove" | null>(null);
  const live = agents.find((a) => a.agent === task.team[0]) ?? agents[0];
  const agentId = live?.agent ?? task.team[0];

  const fail = (title: string) => (error: ApiRequestError) =>
    toast(title, { detail: error.message, tone: "error" });

  return (
    <header className="flex flex-col gap-2.5 border-b border-line px-[22px] pt-3.5 pb-3">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-[3px] bg-fg-faint"
          style={color ? { backgroundColor: color } : undefined}
        />
        <span className="font-mono text-sm text-fg-muted">{task.id}</span>
        {task.org && <span className="font-mono text-sm text-fg-faint">{task.org}</span>}
        <StatusBadge status={task.status} pausedReason={task.pausedReason} />
        <div className="ml-auto flex items-center gap-2">
          {action === "stop" && (
            <Button
              variant="secondary"
              disabled={stop.isPending}
              title="Stop every agent in this task"
              onClick={() => stop.mutate(task.id, { onError: fail("Could not stop") })}
            >
              <OctagonX aria-hidden="true" />
              Stop all
            </Button>
          )}
          {(action === "start" || action === "resume") && (
            <Button
              variant="primary"
              disabled={start.isPending}
              onClick={() => start.mutate(task.id, { onError: fail("Could not start") })}
            >
              {action === "start" ? <Play aria-hidden="true" /> : <RotateCw aria-hidden="true" />}
              {action === "start" ? "Start" : "Resume"}
            </Button>
          )}
          <Menu
            label="Task menu"
            icon={<EllipsisVertical aria-hidden="true" />}
            items={[
              { label: "Close task", onSelect: () => setConfirm("close"), disabled: task.status === "done" },
              { label: "Remove task", onSelect: () => setConfirm("remove"), tone: "danger" },
            ]}
          />
        </div>
      </div>

      <h1 className="text-lg font-semibold text-balance">{task.title}</h1>

      <div className="flex flex-wrap items-center gap-2">
        {task.repos.map((repo) => (
          <span
            key={repo.project}
            className="flex h-[26px] items-center gap-1.5 rounded-sm border border-line-strong bg-field px-2 font-mono text-xs"
          >
            <GitBranch aria-hidden="true" className="size-3 text-fg-faint" />
            <span className="text-fg">{repo.project}:</span>
            <span className="text-fg-muted">
              {repo.branch} from {repo.base}
            </span>
          </span>
        ))}
        {task.repos.length === 0 && task.kind !== "chat" && (
          <span className="text-sm text-amber">
            No repo yet. Say which repos in the room, like "use api and web".
          </span>
        )}
        {agentId && (
          <div className="ml-auto flex min-w-0 flex-col items-end gap-0.5">
            <span className="flex items-center gap-2 text-sm text-fg-muted">
              <AgentAvatar id={agentId} working={isWorking(live)} size={22} />
              <span className="font-mono">{agentId}</span>
              <span className="text-fg-faint">
                {live ? AGENT_STATUS[live.status] : "not started"}
                {live?.model ? ` · ${live.model}` : ""}
              </span>
            </span>
            {live?.nowDoing && isWorking(live) && (
              <span
                className="max-w-[420px] truncate text-xs text-fg-faint"
                title={live.nowDoing}
                aria-live="polite"
              >
                {live.nowDoing}
              </span>
            )}
          </div>
        )}
      </div>

      {confirm === "close" && <CloseDialog task={task} onDone={() => setConfirm(null)} />}
      {confirm === "remove" && <RemoveDialog task={task} onDone={() => setConfirm(null)} />}
    </header>
  );
}

function CloseDialog({ task, onDone }: { task: Task; onDone: () => void }) {
  const close = useCloseTask();
  const toast = useToast();
  return (
    <ConfirmDialog
      title={`Close ${task.id}`}
      body="The task moves to Done. Its worktrees and branches stay until you remove the task."
      confirmLabel="Close task"
      busy={close.isPending}
      error={close.error?.message}
      onCancel={onDone}
      onConfirm={() =>
        close.mutate(task.id, {
          onSuccess: () => {
            toast("Task closed", { detail: task.id });
            onDone();
          },
        })
      }
    />
  );
}

/** Removing a task with uncommitted work is refused by the server; the dialog shows why and offers to force it. */
function RemoveDialog({ task, onDone }: { task: Task; onDone: () => void }) {
  const remove = useRemoveTask();
  const toast = useToast();
  const navigate = useNavigate();
  const [refused, setRefused] = useState(false);

  function run(force: boolean) {
    remove.mutate(force ? { id: task.id, force: true } : { id: task.id }, {
      onSuccess: () => {
        toast("Task removed", { detail: task.id });
        onDone();
        void navigate({ to: "/" });
      },
      onError: (error) => setRefused(!error.unreachable),
    });
  }

  return (
    <ConfirmDialog
      title={`Remove ${task.id}`}
      body="This deletes the task, its folder and its worktrees. Branches already pushed stay on the remote."
      confirmLabel={refused ? "Remove anyway" : "Remove task"}
      busy={remove.isPending}
      error={remove.error?.message}
      onCancel={onDone}
      onConfirm={() => run(refused)}
    />
  );
}
