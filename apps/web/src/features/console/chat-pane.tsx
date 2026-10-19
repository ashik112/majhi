import { type OrgView, type TaskSummary, taskLabel } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useMemo } from "react";
import { Menu } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { agentEntryOptions } from "@/features/chats/new-chat-options";
import { ComposerAutoFocus } from "@/features/room/auto-focus";
import { useNewChat } from "@/lib/chat-queries";
import { useClients } from "@/lib/client-queries";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { ChatChips } from "./chat-chips";
import { type ChatChip, nameOf, projectOf, type WorkState, workspaceName } from "./model";
import { WorkspaceTag, wsStyle } from "./parts";

const ChatBody = lazy(() => import("./chat-body"));

/** The id of the pseudo chat for client chats that wait to be linked (see `chat-body.tsx`). */
const NEW_CHATS = "new-chats";

/** The header of a task's chat: `project · Name`, its workspace, the three lines and the facts. */
function TaskHeader({
  task,
  hues,
  orgs,
}: {
  task: TaskSummary;
  hues: ReadonlyMap<string, number>;
  orgs: readonly OrgView[] | undefined;
}) {
  const branch = task.repos[0]?.branch;
  const facts = [
    branch,
    `${task.team.length} ${task.team.length === 1 ? "agent" : "agents"}`,
    task.priority !== undefined && task.priority !== "normal" ? `${task.priority} priority` : undefined,
    task.due === undefined ? undefined : `due ${task.due}`,
  ].filter((f): f is string => f !== undefined);
  const project = projectOf(task);
  return (
    <div className="cs-th" style={wsStyle(hues, task.org)}>
      <div className="cs-t">
        <Link
          to="/t/$taskId"
          params={{ taskId: task.id }}
          className="cs-x2"
          aria-label={`Open ${project === "" ? "" : `${project} · `}${nameOf(task)}`}
        >
          {project !== "" && <span className="cs-p">{project} · </span>}
          {nameOf(task)}
        </Link>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
        <WorkspaceTag name={workspaceName(orgs, task.org)} org={task.org} hues={hues} />
      </div>
      {(task.now !== undefined || task.next !== undefined || task.doneWhen !== undefined) && (
        <div className="cs-kv">
          {task.now !== undefined && (
            <>
              <i>Now</i>
              <span>{task.now}</span>
            </>
          )}
          {task.next !== undefined && (
            <>
              <i>Next</i>
              <span>{task.next}</span>
            </>
          )}
          {task.doneWhen !== undefined && (
            <>
              <i>Done when</i>
              <span>{task.doneWhen}</span>
            </>
          )}
        </div>
      )}
      <div className="cs-facts">
        {facts.map((f) => (
          <span key={f} className="cs-fact">
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The chips that are not conversations: client chats waiting to be linked, and a way to start a chat with an agent. */
function ChatTools({ selected, onPick }: { selected: string; onPick: (id: string) => void }) {
  const clients = useClients().data;
  const entries = useAgents().data;
  const orgs = useOrgs().data;
  const newChat = useNewChat();
  const waiting =
    (clients?.newChats.length ?? 0) +
    (clients?.accounts.filter((a) => a.trouble === "webhook" || a.trouble === "needs-token").length ?? 0);
  const agents = agentEntryOptions(entries ?? [], orgs ?? []);
  return (
    <>
      {waiting > 0 && (
        <button
          type="button"
          className="cs-chip"
          aria-pressed={selected === NEW_CHATS}
          onClick={() => onPick(NEW_CHATS)}
        >
          <span className="cs-t">New chats</span>
          <span className="cs-unread">{waiting}</span>
        </button>
      )}
      {agents.length > 0 && (
        <Menu
          label="New chat with an agent"
          align="right"
          items={agents.map((a) => ({
            group: a.group,
            label: `@${a.id}`,
            onSelect: () => newChat.mutate(a.id, { onSuccess: (task) => onPick(task.id) }),
          }))}
          trigger={(t) => (
            <button type="button" className="cs-chip" {...t}>
              New chat
            </button>
          )}
        />
      )}
    </>
  );
}

export function ChatPane(props: {
  chips: readonly ChatChip[];
  selected: string;
  /** Every task, to find the one the open chat is (or became) and the work it started. */
  tasks: ReadonlyMap<string, TaskSummary>;
  stateOf: (id: string) => WorkState | undefined;
  hues: ReadonlyMap<string, number>;
  orgs: readonly OrgView[] | undefined;
  focus: boolean;
  open: boolean;
  onPick: (id: string) => void;
  onFocus: () => void;
}) {
  // The chat the owner has open: a task once its work started in it, and work it started elsewhere.
  const open = props.tasks.get(props.selected);
  const moved = useMemo(
    () =>
      [...props.tasks.values()].filter(
        (t) => t.id !== props.selected && t.origin?.kind === "chat" && t.origin.room === props.selected,
      ),
    [props.tasks, props.selected],
  );
  return (
    <section
      className="cs-pane cs-glass"
      data-pane="chat"
      data-focus={props.focus}
      data-open={props.open}
      aria-label="Chat"
      onMouseDownCapture={props.onFocus}
    >
      <ChatChips
        chips={props.chips}
        selected={props.selected}
        stateOf={props.stateOf}
        hues={props.hues}
        orgs={props.orgs}
        onPick={props.onPick}
        tools={<ChatTools selected={props.selected} onPick={props.onPick} />}
      />
      {open !== undefined && open.kind !== "chat" && (
        <TaskHeader task={open} hues={props.hues} orgs={props.orgs} />
      )}
      {moved.map((t) => (
        <p key={t.id} className="cs-moved">
          Work moved to{" "}
          <Link to="/t/$taskId" params={{ taskId: t.id }}>
            {taskLabel(t, workspaceName(props.orgs, t.org))}
          </Link>
        </p>
      ))}
      <div className="cs-rule" />
      <Suspense
        fallback={
          <div className="cs-chat-body" role="status" aria-busy="true" aria-label="Opening the chat">
            <Skeleton className="h-16 w-2/3 rounded-lg" />
          </div>
        }
      >
        <ComposerAutoFocus.Provider value={false}>
          <ChatBody id={props.selected} />
        </ComposerAutoFocus.Provider>
      </Suspense>
    </section>
  );
}
