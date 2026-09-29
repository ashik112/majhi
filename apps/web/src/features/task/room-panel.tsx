import { type AgentLive, collapseHome, type RoomItem, type Task } from "@majhi/shared";
import { Check, Copy, OctagonX, Play, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { useAgentIndex } from "@/lib/agent-index";
import type { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useConfig } from "@/lib/queries";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useCloseTask, useStartTask, useStopTask } from "@/lib/task-queries";
import { useCopy } from "@/lib/use-copy";
import { useNow } from "@/lib/use-now";
import { ChangesPanel } from "../room/changes-panel";
import { AgentRow } from "./agent-row";
import { type ActionCopy, actionCopy, agentState } from "./model";

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
  const accounts = useAccounts().data;
  const now = useNow(30_000);
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
        return (
          <AgentRow
            key={id}
            task={task.id}
            id={id}
            live={live}
            info={info}
            state={agentState(live, task.pausedReason)}
            account={accounts?.find((a) => a.id === info?.account)}
            now={now}
            defaultOpen={task.team.length === 1}
          />
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
