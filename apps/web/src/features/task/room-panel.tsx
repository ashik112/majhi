import {
  type AgentLive,
  collapseHome,
  type ProcessInfo,
  type RoomItem,
  type Task,
  type TaskRepo,
} from "@majhi/shared";
import { Copy } from "lucide-react";
import { OpenInEditor } from "@/components/open-in-editor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useAgentIndex } from "@/lib/agent-index";
import { useConfig } from "@/lib/queries";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useTaskBranches, useUpdateTask } from "@/lib/task-queries";
import { useCopy } from "@/lib/use-copy";
import { useNow } from "@/lib/use-now";
import { showsMrCard } from "../mrs/model";
import { MrCard } from "../mrs/mr-card";
import { ChangesPanel } from "../room/changes-panel";
import { AgentRow } from "./agent-row";
import { ChangeAgent } from "./change-agent";
import { agentState, agentsBusy } from "./model";
import { ProcessesCard } from "./processes-card";
import { PendingShipLine } from "./ship";
import { SubtasksCard } from "./subtasks-card";
import { AddAgent, MemberMenu, ModePicker } from "./team-controls";

/** The right column of the task view: who is in the room, the branch, the changes. */
export function RoomPanel({
  task,
  agents,
  items,
  processes,
  onShowChanges,
}: {
  task: Task;
  agents: readonly AgentLive[];
  items: readonly RoomItem[];
  processes: readonly ProcessInfo[];
  /** Opens the Changes tab. */
  onShowChanges?: (() => void) | undefined;
}) {
  return (
    <aside
      aria-label="Task details"
      className="flex w-[320px] shrink-0 flex-col gap-2.5 overflow-y-auto pb-6 scroll-fade"
    >
      <InRoomCard task={task} agents={agents} />
      <SubtasksCard task={task} />
      <ProcessesCard task={task} processes={processes} />
      {showsMrCard(task) && <MrCard task={task} />}
      <BranchCard task={task} />
      {/* With a repo the Changes tab is the one place for it; the card is for a task with none. */}
      {task.repos.length === 0 && <ChangesPanel task={task} items={items} onShowChanges={onShowChanges} />}
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
            showFresh={task.kind === "chat"}
            change={
              task.kind === "chat" ? (
                <ChangeAgent task={task} busy={busy} />
              ) : (
                <MemberMenu
                  task={task}
                  id={id}
                  busy={live !== undefined && agentsBusy([live])}
                  hasSession={live !== undefined}
                />
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

/** The branch the worktree is cut from. Until the task starts, a pick changes it. */
function StartingBranch({ task, repo }: { task: Task; repo: TaskRepo }) {
  const waiting = (task.status === "inbox" || task.status === "ready") && repo.worktree === undefined;
  const branches = useTaskBranches(task.id, waiting);
  const update = useUpdateTask();
  const toast = useToast();
  if (!waiting) {
    return (
      <span className="text-xs text-fg-faint">
        Starting branch <span className="font-mono text-fg-soft">{repo.base}</span>
      </span>
    );
  }
  const entry = branches.data?.find((r) => r.project === repo.project);
  const local = [...new Set([repo.base, ...(entry?.branches ?? [])])];
  const remote = [...new Set(entry?.remote ?? [])].filter((b) => !local.includes(b));
  return (
    <div className="flex items-center gap-2 text-xs text-fg-faint">
      <span className="shrink-0">Starting branch</span>
      <Select
        aria-label={`Starting branch of ${repo.project}`}
        value={repo.base}
        disabled={update.isPending}
        title={repo.base}
        onChange={(e) =>
          update.mutate(
            {
              id: task.id,
              base: e.target.value,
              ...(task.repos.length > 1 ? { project: repo.project } : {}),
            },
            {
              onError: (err) =>
                toast("Could not change the starting branch", { detail: err.message, tone: "error" }),
            },
          )
        }
        className="h-7 min-w-0 flex-1 font-mono text-sm"
      >
        <optgroup label="Local">
          {local.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </optgroup>
        {remote.length > 0 && (
          <optgroup label="Remote only">
            {remote.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
    </div>
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
            <span className="[overflow-wrap:anywhere]">{repo.branch}</span>
          </CopyValue>
          <StartingBranch task={task} repo={repo} />
          {repo.worktree ? (
            <CopyValue
              value={repo.worktree}
              label={`Copy worktree path of ${repo.project}`}
              onCopy={() => void copy(repo.worktree ?? "", shown(repo.worktree ?? ""))}
              action={
                <OpenInEditor
                  path={repo.worktree}
                  name={`worktree of ${repo.project}`}
                  size="icon-sm"
                  variant="ghost"
                  className="-mt-1 size-6 shrink-0 opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                />
              }
            >
              {shown(repo.worktree)}
            </CopyValue>
          ) : (
            <span className="text-xs text-fg-faint">
              {task.status === "done" ? "The worktree was removed." : "No worktree yet. Start makes one."}
            </span>
          )}
        </div>
      ))}
      <PendingShipLine task={task} />
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
      {task.repos.length === 0 && task.kind === "code" && (
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
  action,
}: {
  children: React.ReactNode;
  value: string;
  label: string;
  onCopy: () => void;
  /** Another icon button, placed before the copy button. */
  action?: React.ReactNode;
}) {
  return (
    <div className="group flex items-start gap-1">
      <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere] text-xs leading-[1.45]">
        {children}
      </span>
      {action}
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
