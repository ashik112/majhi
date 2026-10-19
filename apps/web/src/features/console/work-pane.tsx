import type { OrgView, TaskSummary } from "@majhi/shared";
import { memo } from "react";
import {
  ageWord,
  nameOf,
  type ProjectGroup,
  projectOf,
  type Rails,
  WORK_STATE_LAMP,
  WORK_STATE_TONE,
  WORK_STATE_WORD,
  type WorkRow,
  type WorkState,
  type WorkspaceGroup,
  workspaceMeta,
  workspaceName,
} from "./model";
import type { ActionDef } from "./needs-pane";
import { type PaneItem, PaneList } from "./pane-list";
import { Btn, Chevron, ConsoleLamp, Kbd, RowTitle, WorkspaceTag, wsStyle } from "./parts";

export type RailId = "queued" | "ideas" | "done";

export const RAIL_LABEL: Record<RailId, string> = {
  queued: "Up next, starts as slots free",
  ideas: "Ideas from agents and the captain",
  done: "Done today",
};

/** What a row in Work stands for: a task in a project group, or one under an open rail. */
export interface WorkEntry {
  task: TaskSummary;
  /** `rail` rows belong to an open rail and show their full label, project first. */
  rail: RailId | undefined;
  state: WorkState | undefined;
}

type Item =
  | (PaneItem & { type: "ws"; group: WorkspaceGroup; closed: boolean })
  | (PaneItem & { type: "sub"; project: string })
  | (PaneItem & { type: "row"; entry: WorkEntry })
  | (PaneItem & { type: "fold"; project: string; rows: readonly WorkRow[]; names: string })
  | (PaneItem & { type: "later"; total: number })
  | (PaneItem & { type: "rail"; id: RailId; count: number; open: boolean });

function entryOf(row: WorkRow): WorkEntry {
  return { task: row.task, rail: undefined, state: row.state };
}

/** The list of the pane, and its selectable entries in the same order. */
export function workItems(input: {
  work: readonly WorkspaceGroup[];
  rails: Rails;
  closedOrgs: ReadonlySet<string>;
  openFolds: ReadonlySet<string>;
  openRails: ReadonlySet<RailId>;
  tasks: ReadonlyMap<string, TaskSummary>;
}): Item[] {
  const out: Item[] = [];
  for (const group of input.work) {
    const closed = input.closedOrgs.has(group.org);
    out.push({ key: `w:${group.org}`, type: "ws", group, closed });
    if (closed) continue;
    const several = group.projects.length > 1;
    for (const project of group.projects) {
      if (several || project.project !== "") {
        out.push({ key: `p:${group.org}:${project.project}`, type: "sub", project: project.project });
      }
      const foldKey = `${group.org}:${project.project}`;
      const unfolded = input.openFolds.has(foldKey);
      const rows = unfolded ? [...project.rows, ...project.folded] : project.rows;
      for (const row of rows) out.push({ key: row.task.id, type: "row", entry: entryOf(row) });
      if (project.folded.length > 0 && !unfolded) {
        out.push({
          key: `f:${foldKey}`,
          type: "fold",
          project: foldKey,
          rows: project.folded,
          names: project.folded.map((r) => nameOf(r.task)).join(", "),
        });
      }
    }
  }
  const { queued, ideas, doneToday } = input.rails;
  out.push({ key: "later", type: "later", total: queued.length + ideas.length + doneToday.length });
  const rails: [RailId, readonly TaskSummary[]][] = [
    ["queued", queued],
    ["ideas", ideas],
    ["done", doneToday],
  ];
  for (const [id, list] of rails) {
    const open = input.openRails.has(id);
    out.push({ key: `r:${id}`, type: "rail", id, count: list.length, open });
    if (open)
      for (const task of list)
        out.push({ key: `${id}:${task.id}`, type: "row", entry: { task, rail: id, state: undefined } });
  }
  return out;
}

/** The entries a key can select, in order. */
export function selectableEntries(items: readonly Item[]): WorkEntry[] {
  return items.flatMap((i) => (i.type === "row" ? [i.entry] : []));
}

/** The key of a row in the list: a rail row is keyed by its rail too, so a task can be in both. */
export function entryKey(entry: WorkEntry): string {
  return entry.rail === undefined ? entry.task.id : `${entry.rail}:${entry.task.id}`;
}

interface RowProps {
  entry: WorkEntry;
  selected: boolean;
  now: number;
  unread: number;
  hues: ReadonlyMap<string, number>;
  orgs: readonly OrgView[] | undefined;
  /** The task's Now line: its own, else what its agent does. */
  nowLine: string | undefined;
  waitsOn: string | undefined;
  actions: readonly ActionDef[] | undefined;
  onSelect: (key: string) => void;
}

function railWord(rail: RailId): string {
  return rail === "queued" ? "queued" : rail === "ideas" ? "idea" : "done";
}

const RowView = memo(function RowView(props: RowProps) {
  const { entry, selected, now, hues, nowLine } = props;
  const { task, state, rail } = entry;
  const lamp = state === undefined ? (rail === "done" ? "done" : "idle") : WORK_STATE_LAMP[state];
  const word = state === undefined ? railWord(rail ?? "queued") : WORK_STATE_WORD[state];
  const tone = state === undefined ? "idle" : WORK_STATE_TONE[state];
  const prefix = rail === undefined ? undefined : projectOf(task) || workspaceName(props.orgs, task.org);
  const gist =
    nowLine ??
    (state === "blocked" || rail === "queued" ? props.waitsOn : undefined) ??
    (rail === "queued"
      ? "Starts when a slot frees"
      : rail === "ideas"
        ? "Waits for you to start it"
        : undefined);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the console takes the keys itself (J, K, A, Enter)
    <div
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-label={`${projectOf(task)} ${nameOf(task)}`}
      className="cs-row"
      data-task={task.id}
      style={wsStyle(hues, task.org)}
      onClick={() => props.onSelect(entryKey(entry))}
    >
      <ConsoleLamp state={lamp} />
      <div className="cs-main-line">
        <RowTitle prefix={prefix} name={nameOf(task)} />
        <span className="cs-gist">{gist ?? <span className="cs-unset">No status yet</span>}</span>
      </div>
      <div className="cs-end">
        {props.unread > 0 && <span className="cs-unread">{props.unread}</span>}
        {rail === "done" ? (
          <span className="cs-age">{ageWord(task.updatedAt, now)}</span>
        ) : (
          <span className="cs-st" data-tone={tone}>
            {word}
          </span>
        )}
      </div>
      {selected && (
        <div className="cs-det">
          {task.next !== undefined && (
            <div className="cs-q">
              <span className="cs-lbl">Next</span>
              {task.next}
            </div>
          )}
          {task.doneWhen !== undefined && (
            <div className="cs-q">
              <span className="cs-lbl">Done when</span>
              {task.doneWhen}
            </div>
          )}
          <div className="cs-acts">
            {props.actions?.map((a) => (
              <Btn
                key={a.id}
                primary={a.primary === true}
                ghost={a.ghost === true}
                className="cs-needsable"
                keyHint={a.primary === true ? "A" : undefined}
                onClick={a.run}
              >
                {a.label}
                {a.primary !== true && a.id === "stop" && <Kbd>S</Kbd>}
                {a.primary !== true && a.id === "start-now" && <Kbd>.</Kbd>}
                {a.id === "open" && <Kbd>↵</Kbd>}
              </Btn>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export function WorkPane(props: {
  items: readonly Item[];
  selectedKey: string | undefined;
  focus: boolean;
  now: number;
  hues: ReadonlyMap<string, number>;
  orgs: readonly OrgView[] | undefined;
  openCount: number;
  orgCount: number;
  unreadOf: (id: string) => number;
  nowLineOf: (task: TaskSummary) => string | undefined;
  waitsOnOf: (task: TaskSummary) => string | undefined;
  actions: readonly ActionDef[] | undefined;
  onSelect: (key: string) => void;
  onToggleOrg: (org: string) => void;
  onUnfold: (key: string) => void;
  onToggleRail: (id: RailId) => void;
  onNewTask: () => void;
  onFocus: () => void;
}) {
  return (
    <section
      className="cs-pane cs-glass"
      data-pane="work"
      data-focus={props.focus}
      aria-label="Work"
      onMouseDownCapture={props.onFocus}
    >
      <div className="cs-phead">
        <ConsoleLamp state="working" />
        <h2>Work</h2>
        <span className="cs-sub">
          <b>{props.openCount}</b> open in <b>{props.orgCount}</b> workspace{props.orgCount === 1 ? "" : "s"}
        </span>
        <div className="cs-right">
          <Btn primary onClick={props.onNewTask} keyHint="N">
            New task
          </Btn>
        </div>
      </div>
      <div className="cs-rule" />
      <PaneList
        items={props.items}
        label="Work"
        selectedKey={props.selectedKey}
        render={(item) => {
          switch (item.type) {
            case "ws":
              return (
                <button
                  type="button"
                  className="cs-gh cs-ws-h"
                  aria-expanded={!item.closed}
                  onClick={() => props.onToggleOrg(item.group.org)}
                >
                  <WorkspaceTag
                    name={workspaceName(props.orgs, item.group.org)}
                    org={item.group.org}
                    hues={props.hues}
                  />
                  <span className="cs-meta">{workspaceMeta(item.group.counts)}</span>
                  <Chevron />
                </button>
              );
            case "sub":
              return <div className="cs-sub-h">{item.project === "" ? "No repo" : item.project}</div>;
            case "fold":
              return (
                <button type="button" className="cs-more" onClick={() => props.onUnfold(item.project)}>
                  <ConsoleLamp state="paused" />
                  {item.rows.length} blocked: {item.names}
                </button>
              );
            case "later":
              return (
                <div className="cs-gh" style={{ marginTop: 4, cursor: "default" }}>
                  Later and done <span className="cs-n">{item.total}</span>
                </div>
              );
            case "rail":
              return (
                <button
                  type="button"
                  className="cs-rail"
                  aria-expanded={item.open}
                  onClick={() => props.onToggleRail(item.id)}
                >
                  <ConsoleLamp state={item.id === "done" ? "done" : "idle"} />
                  {RAIL_LABEL[item.id]}
                  <span className="cs-n">{item.count}</span>
                </button>
              );
            case "row": {
              const key = entryKey(item.entry);
              const selected = props.focus && props.selectedKey === key;
              return (
                <RowView
                  entry={item.entry}
                  selected={selected}
                  now={props.now}
                  unread={props.unreadOf(item.entry.task.id)}
                  hues={props.hues}
                  orgs={props.orgs}
                  nowLine={props.nowLineOf(item.entry.task)}
                  waitsOn={props.waitsOnOf(item.entry.task)}
                  actions={selected ? props.actions : undefined}
                  onSelect={props.onSelect}
                />
              );
            }
          }
        }}
      />
      <div className="cs-foot">
        <span>
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span>
          <Kbd>S</Kbd> stop
        </span>
        <span>
          <Kbd>.</Kbd> start now
        </span>
        <span>
          <Kbd>[</Kbd> fold
        </span>
        <span>
          <Kbd>⇥</Kbd> next pane
        </span>
      </div>
    </section>
  );
}

export type { ProjectGroup };
