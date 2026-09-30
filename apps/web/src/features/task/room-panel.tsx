import { type AgentLive, collapseHome, type ProcessInfo, type RoomItem, type Task } from "@majhi/shared";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAgentIndex } from "@/lib/agent-index";
import { useConfig } from "@/lib/queries";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useCopy } from "@/lib/use-copy";
import { useNow } from "@/lib/use-now";
import { ChangesPanel } from "../room/changes-panel";
import { AgentRow } from "./agent-row";
import { ChangeAgent } from "./change-agent";
import { agentState, agentsBusy } from "./model";
import { ProcessesCard } from "./processes-card";
import { AddAgent, MemberMenu, ModePicker } from "./team-controls";

/** The right column of the task view: who is in the room, the branch, the changes. */
export function RoomPanel({
  task,
  agents,
  items,
  processes,
}: {
  task: Task;
  agents: readonly AgentLive[];
  items: readonly RoomItem[];
  processes: readonly ProcessInfo[];
}) {
  return (
    <aside
      aria-label="Task details"
      className="flex w-[320px] shrink-0 flex-col gap-2.5 overflow-y-auto pb-1"
    >
      <InRoomCard task={task} agents={agents} />
      <ProcessesCard task={task} processes={processes} />
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
  const busy = agentsBusy(agents);
  return (
    <Card aria-labelledby="in-room-heading" className="gap-0 px-3 py-2.5">
      <div className="flex items-center gap-2 pb-1">
        <h2 id="in-room-heading" className="text-sm font-semibold">
          In this room
        </h2>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-faint">
          {orgName ? `${orgName} agents + root agents` : "Root agents"}
        </span>
        {task.kind !== "chat" && task.team.length > 0 && <AddAgent task={task} />}
      </div>
      {task.team.length > 1 && (
        <div className="flex items-center pb-1">
          <ModePicker task={task} />
        </div>
      )}
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
            change={
              task.kind === "chat" ? (
                <ChangeAgent task={task} busy={busy} />
              ) : (
                <MemberMenu task={task} id={id} busy={live !== undefined && agentsBusy([live])} />
              )
            }
          />
        );
      })}
      {task.team.length === 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-fg-faint">No agent yet.</p>
          <ChangeAgent task={task} busy={busy} />
        </div>
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
    <Card aria-label="Branch and worktree" className="gap-2 px-3 py-2.5">
      {task.repos.map((repo) => (
        <div key={repo.project} className="flex flex-col gap-1">
          <span className="text-xs text-fg-faint">
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
            <span className="text-xs text-fg-faint">No worktree yet. Start makes one.</span>
          )}
        </div>
      ))}
      {task.repos.length === 0 && task.kind === "chat" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-faint">Task folder</span>
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
      <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere] text-xs leading-[1.45]">
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
