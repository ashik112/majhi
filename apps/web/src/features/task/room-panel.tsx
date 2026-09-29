import { type AgentLive, collapseHome, type RoomItem, type Task } from "@majhi/shared";
import { Check, Copy, OctagonX, Play, RotateCw } from "lucide-react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { useAgentIndex } from "@/lib/agent-index";
import type { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useConfig } from "@/lib/queries";
import { useOrgs } from "@/lib/studio-queries";
import { useCloseTask, useStartTask, useStopTask } from "@/lib/task-queries";
import { useCopy } from "@/lib/use-copy";
import { ChangesPanel } from "../room/changes-panel";
import { type ActionCopy, actionCopy, agentDot, agentState, modelLabel } from "./model";

const STATE_TEXT = {
  amber: "text-amber",
  violet: "text-violet",
  red: "text-red",
  muted: "text-fg-muted",
  faint: "text-fg-dim",
} as const;

const ACTION_TEXT = {
  amber: "text-amber",
  blue: "text-blue",
  green: "text-green",
  violet: "text-violet",
  coral: "text-coral",
  neutral: "text-fg-muted",
  faint: "text-fg-muted",
} as const;

/** The right column of the task view: who is in the room, the main action, the branch, the changes. */
export function RoomPanel({
  task,
  agents,
  items,
  yourTurn,
}: {
  task: Task;
  agents: readonly AgentLive[];
  items: readonly RoomItem[];
  yourTurn: boolean;
}) {
  return (
    <aside aria-label="Task details" className="flex w-[380px] shrink-0 flex-col gap-3 overflow-y-auto pb-1">
      <InRoomCard task={task} agents={agents} />
      <ActionCard task={task} yourTurn={yourTurn} />
      <BranchCard task={task} />
      <ChangesPanel task={task} items={items} />
    </aside>
  );
}

function InRoomCard({ task, agents }: { task: Task; agents: readonly AgentLive[] }) {
  const index = useAgentIndex();
  const orgs = useOrgs().data;
  const orgName = orgs?.find((o) => o.id === task.org)?.name;
  return (
    <Card aria-labelledby="in-room-heading">
      <div className="flex items-baseline gap-2">
        <h2 id="in-room-heading" className="text-body font-semibold">
          In this room
        </h2>
        <span className="min-w-0 truncate text-sm text-fg-faint">
          {orgName ? `${orgName} agents + root agents` : "Root agents"}
        </span>
      </div>
      {task.team.map((id) => {
        const live = agents.find((a) => a.agent === id);
        const info = index.get(id);
        const state = agentState(live);
        const model = modelLabel(live, info?.model);
        return (
          <div key={id} className="flex items-start gap-2.5 border-t border-line-strong pt-2.5">
            <AgentAvatar id={id} size={28} dot={agentDot(live)} />
            <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
              <span className="flex items-baseline gap-2">
                <span className="truncate font-mono text-base font-medium">@{id}</span>
                {info && (
                  <span className="rounded-sm bg-selected px-1.5 py-0.5 text-xs text-fg-soft">
                    {info.role}
                  </span>
                )}
                <span className={cn("text-xs", STATE_TEXT[state.tone])}>{state.label}</span>
              </span>
              <span className="flex flex-wrap gap-1.5">
                {info && (
                  <span className="flex h-[26px] items-center rounded-sm border border-line-control px-2 font-mono text-xs text-fg-soft">
                    {info.account}
                  </span>
                )}
                <span className="flex h-[26px] items-center rounded-sm border border-line-control bg-blue-wash px-2 font-mono text-xs text-blue-soft">
                  {model ?? "account default"}
                </span>
              </span>
              {live?.nowDoing && state.tone === "amber" && (
                <span aria-live="polite" title={live.nowDoing} className="truncate text-xs text-fg-faint">
                  {live.nowDoing}
                </span>
              )}
              {live && live.queued > 0 && (
                <span className="tnum text-xs text-fg-faint">{live.queued} queued</span>
              )}
            </div>
          </div>
        );
      })}
      {task.team.length === 0 && <p className="text-sm text-fg-faint">No agent yet.</p>}
    </Card>
  );
}

function ActionCard({ task, yourTurn }: { task: Task; yourTurn: boolean }) {
  const start = useStartTask();
  const stop = useStopTask();
  const close = useCloseTask();
  const toast = useToast();
  const copy: ActionCopy = actionCopy(task, yourTurn);
  const fail = (title: string) => (error: ApiRequestError) =>
    toast(title, { detail: error.message, tone: "error" });

  return (
    <Card aria-label="Task action" className={cn(copy.warm && "border-red-line")}>
      <p className={cn("text-base text-pretty", ACTION_TEXT[copy.tone])}>{copy.text}</p>
      {copy.kind === "start" && (
        <Button
          variant="primary"
          size="xl"
          disabled={start.isPending}
          onClick={() => start.mutate(task.id, { onError: fail("Could not start") })}
        >
          <Play aria-hidden="true" />
          Start
        </Button>
      )}
      {copy.kind === "resume" && (
        <Button
          variant="primary"
          size="xl"
          disabled={start.isPending}
          onClick={() => start.mutate(task.id, { onError: fail("Could not resume") })}
        >
          <RotateCw aria-hidden="true" />
          Resume
        </Button>
      )}
      {copy.kind === "done" && (
        <Button
          variant="primary"
          size="xl"
          disabled={close.isPending}
          onClick={() => close.mutate(task.id, { onError: fail("Could not mark it done") })}
        >
          <Check aria-hidden="true" />
          Mark done
        </Button>
      )}
      {copy.kind === "stop" && (
        <Button
          size="xl"
          className="bg-field font-medium"
          disabled={stop.isPending}
          title="Stop every agent in this task"
          onClick={() => stop.mutate(task.id, { onError: fail("Could not stop") })}
        >
          <OctagonX aria-hidden="true" />
          Stop all
        </Button>
      )}
    </Card>
  );
}

function BranchCard({ task }: { task: Task }) {
  const config = useConfig().data;
  const copy = useCopy();
  const home = config?.status === "loaded" ? config.home : undefined;
  const shown = (path: string) => (home ? collapseHome(path, home) : path);

  return (
    <Card aria-label="Branch and worktree" className="gap-3">
      {task.repos.map((repo) => (
        <div key={repo.project} className="flex flex-col gap-1.5">
          <span className="text-sm text-fg-faint">
            Branch and worktree{task.repos.length > 1 && <span className="font-mono"> · {repo.project}</span>}
          </span>
          <CopyValue
            value={repo.branch}
            label={`Copy branch of ${repo.project}`}
            onCopy={() => void copy(repo.branch)}
          >
            <span className="[overflow-wrap:anywhere]">{repo.branch}</span>{" "}
            <span className="whitespace-nowrap text-fg-faint">from {repo.base}</span>
          </CopyValue>
          {repo.worktree ? (
            <CopyValue
              value={repo.worktree}
              label={`Copy worktree path of ${repo.project}`}
              onCopy={() => void copy(repo.worktree ?? "", shown(repo.worktree ?? ""))}
            >
              {shown(repo.worktree)}
            </CopyValue>
          ) : (
            <span className="text-xs text-fg-faint">
              Worktree not created yet. It is made when the task starts.
            </span>
          )}
        </div>
      ))}
      {task.repos.length === 0 && task.kind === "chat" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-fg-faint">Task folder</span>
          <CopyValue
            value={task.folder}
            label="Copy task folder path"
            onCopy={() => void copy(task.folder, shown(task.folder))}
          >
            {shown(task.folder)}
          </CopyValue>
          <span className="text-xs text-fg-faint">A chat task has no worktree.</span>
        </div>
      )}
      {task.repos.length === 0 && task.kind !== "chat" && (
        <p className="text-sm text-amber">
          No repo yet. Say which repos in the room, like "use api and web".
        </p>
      )}
    </Card>
  );
}

function CopyValue({
  children,
  label,
  onCopy,
}: {
  children: React.ReactNode;
  value: string;
  label: string;
  onCopy: () => void;
}) {
  return (
    <div className="group flex items-start gap-1">
      <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere] text-sm leading-[1.45]">
        {children}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="-mt-1 -mr-1.5 size-6 shrink-0 opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={label}
        title="Copy"
        onClick={onCopy}
      >
        <Copy aria-hidden="true" />
      </Button>
    </div>
  );
}
