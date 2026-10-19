import { type OrgView, type TaskSummary, taskLabel } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Menu } from "@/components/ui/menu";
import { ComposerAutoFocus } from "@/features/room/auto-focus";
import { type ChatChip, nameOf, projectOf, WORK_STATE_LAMP, type WorkState, workspaceName } from "./model";
import { ConsoleLamp, WorkspaceTag, wsStyle } from "./parts";

const ChatBody = lazy(() => import("./chat-body"));

/** Chips shown before the rest go under "More". */
const CHIPS_SHOWN = 8;

function Chip({
  chip,
  pressed,
  stateOf,
  hues,
  orgs,
  onPick,
}: {
  chip: ChatChip;
  pressed: boolean;
  stateOf: WorkState | undefined;
  hues: ReadonlyMap<string, number>;
  orgs: readonly OrgView[] | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <button type="button" className="cs-chip" aria-pressed={pressed} onClick={() => onPick(chip.id)}>
      {chip.kind === "captain" ? (
        <span className="cs-mark" style={{ width: 16, height: 16, lineHeight: "16px", fontSize: 8, borderRadius: 4 }}>
          mj
        </span>
      ) : chip.kind === "task" && stateOf !== undefined ? (
        <ConsoleLamp state={WORK_STATE_LAMP[stateOf]} />
      ) : (
        <WorkspaceTag name="" org={chip.org} hues={hues} />
      )}
      <span className="cs-t">{chip.title}</span>
      {chip.kind === "conversation" && chip.org !== undefined && (
        <span style={wsStyle(hues, chip.org)} className="cs-wsname">
          {workspaceName(orgs, chip.org)}
        </span>
      )}
      {chip.unread > 0 && <span className="cs-unread">{chip.unread}</span>}
    </button>
  );
}

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
        <Link to="/t/$taskId" params={{ taskId: task.id }} className="cs-x2" aria-label={`Open ${project === "" ? "" : `${project} · `}${nameOf(task)}`}>
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
  const shown = props.chips.slice(0, CHIPS_SHOWN);
  // The chosen chat always shows, even when it would fall under More.
  const chosen = props.chips.find((c) => c.id === props.selected);
  if (chosen !== undefined && !shown.includes(chosen)) shown.push(chosen);
  const more = props.chips.filter((c) => !shown.includes(c));
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
      <div className="cs-chips">
        {shown.map((chip) => (
          <Chip
            key={chip.id}
            chip={chip}
            pressed={chip.id === props.selected}
            stateOf={chip.kind === "task" ? props.stateOf(chip.id) : undefined}
            hues={props.hues}
            orgs={props.orgs}
            onPick={props.onPick}
          />
        ))}
        {more.length > 0 && (
          <Menu
            label="More chats"
            align="left"
            items={more.map((c) => ({ label: c.title, onSelect: () => props.onPick(c.id) }))}
            trigger={(t) => (
              <button type="button" className="cs-chip" {...t}>
                {more.length} more
              </button>
            )}
          />
        )}
      </div>
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

