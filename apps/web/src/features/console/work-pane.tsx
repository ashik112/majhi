import type { OrgView, TaskSummary } from "@majhi/shared";
import { memo } from "react";
import { useNow } from "@/lib/use-now";
import {
  ageWord,
  CARD_TAG,
  cardKindOf,
  clockOf,
  nameOf,
  type ProjectGroup,
  projectOf,
  type Rails,
  runClock,
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
import { Btn, Chevron, ConsoleLamp, Kbd, MinimizeButton, RowTitle, WorkspaceTag, wsStyle } from "./parts";

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

/** What an agent does now, for the card of a task it works on. */
export interface Doing {
  agent: string;
  text: string | undefined;
  /** When its turn began, and when the tool call in progress did (UTC ISO). */
  since: string | undefined;
  toolSince: string | undefined;
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
  /** The card that waits for the owner on this task, as its question. */
  ask: string | undefined;
  /** The agent's turn and its tool call in progress, for a card that is working. */
  doing: Doing | undefined;
  /** The buttons on the card: the answers of a card that waits, Stop on one that works, Resume on one that paused. */
  buttons: readonly ActionDef[] | undefined;
  actions: readonly ActionDef[] | undefined;
  onSelect: (key: string) => void;
  onMakeTask: (task: string, followUp: string) => void;
}

function railWord(rail: RailId): string {
  return rail === "queued" ? "queued" : rail === "ideas" ? "idea" : "done";
}

/** A live m:ss, ticking each second, for a card that works. */
function Clock({ since }: { since: string }) {
  const now = useNow(1000);
  return <span className="cs-card-clock">{runClock(since, now)}</span>;
}

/** The buttons of a card: the first non-ghost one is filled when the card waits for the owner. */
function CardButtons({ buttons, needs }: { buttons: readonly ActionDef[]; needs: boolean }) {
  return (
    <div className="cs-card-acts">
      {buttons.map((a, i) => (
        <Btn
          key={a.id}
          primary={needs && i === 0 && a.ghost !== true}
          ghost={a.ghost === true}
          className="cs-needsable"
          onClick={a.run}
        >
          {a.label}
        </Btn>
      ))}
    </div>
  );
}

/**
 * A task in Work as a card whose look follows its state: an incident is red, work in progress is amber, what waits
 * for the owner is blue with its question and its answers, what is blocked is muted and has no buttons. No left stripe.
 */
const CardView = memo(function CardView(props: RowProps) {
  const { entry, selected, now, hues, doing } = props;
  const { task, state } = entry;
  const kind = cardKindOf(task, state ?? "paused");
  const kase = task.case;
  const summaryLines = (kase?.summary ?? "").split("\n").filter((l) => l.trim() !== "");
  const running =
    kind === "working" || (kind === "incident" && state === "working") ? doing?.text : undefined;
  // Who and when, at the right of the head: the client of a case, the agent at work, else how long it has waited.
  const who =
    kase !== undefined
      ? `${kase.client} · ${clockOf(kase.openedAt)}`
      : kind === "working" && doing !== undefined
        ? `@${doing.agent}`
        : ageWord(task.updatedAt, now);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the console takes the keys itself (J, K, A, Enter)
    <div
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-label={`${projectOf(task)} ${nameOf(task)}`}
      className="cs-card"
      data-card={kind}
      data-task={task.id}
      style={wsStyle(hues, task.org)}
      onClick={() => props.onSelect(entryKey(entry))}
    >
      <div className="cs-card-h">
        <span className="cs-tag" data-card={kind}>
          {CARD_TAG[kind]}
        </span>
        <span className="cs-card-t">{nameOf(task)}</span>
        {props.unread > 0 && <span className="cs-unread">{props.unread}</span>}
        <span className="cs-card-who">
          {who}
          {kind === "working" && doing?.since !== undefined && (
            <>
              {" · "}
              <Clock since={doing.since} />
            </>
          )}
        </span>
      </div>
      {kase !== undefined && (
        <div className="cs-card-l">
          <span className="cs-card-dot" aria-hidden="true" />
          {kase.toldAt !== undefined
            ? `Client told ${clockOf(kase.toldAt)}${kase.toldText === undefined ? "" : `: ${kase.toldText}`}`
            : kase.symptom}
        </div>
      )}
      {kase?.helper !== undefined && kase.helper.endedAt === undefined && (
        <div className="cs-card-l">
          @{kase.helper.agent}: {kase.helper.job}
          {" · "}
          <Clock since={kase.helper.startedAt} />
        </div>
      )}
      {running !== undefined && (
        <div className="cs-card-run">
          <span className="cs-card-ru">▶ Running</span>
          <code className="cs-cmd" title={running}>
            {running}
          </code>
          {doing?.toolSince !== undefined && <Clock since={doing.toolSince} />}
        </div>
      )}
      {kind === "needs" && (props.ask !== undefined || task.now !== undefined) && (
        <div className="cs-card-l">{props.ask ?? task.now}</div>
      )}
      {kase !== undefined && props.ask !== undefined && (
        <div className="cs-card-l" data-needs="true">
          <span className="cs-lbl">Needs you</span>
          {props.ask}
        </div>
      )}
      {(kind === "incident" || kind === "working") &&
        props.nowLine !== undefined &&
        running === undefined && (
          <div className="cs-card-l">
            <span className="cs-lbl">Now</span>
            {props.nowLine}
          </div>
        )}
      {kind === "working" && task.next !== undefined && (
        <div className="cs-card-l">
          <span className="cs-lbl">Next</span>
          {task.next}
        </div>
      )}
      {(kind === "blocked" || kind === "paused") &&
        (props.waitsOn !== undefined || props.nowLine !== undefined) && (
          <div className="cs-card-l">{props.waitsOn ?? props.nowLine}</div>
        )}
      {kind === "mr" && props.nowLine !== undefined && <div className="cs-card-l">{props.nowLine}</div>}
      {props.buttons !== undefined && props.buttons.length > 0 && kind !== "blocked" && (
        <CardButtons buttons={props.buttons} needs={kind === "needs" || props.ask !== undefined} />
      )}
      {selected && (
        <div className="cs-det">
          {kase !== undefined && summaryLines.length > 0 && (
            <div className="cs-q" data-full="true">
              {kase.summary}
            </div>
          )}
          {kase?.followUps.map((f) => (
            <div key={f.id} className="cs-q">
              <span className="cs-lbl">Follow-up</span>
              {f.text}
              {f.task === undefined ? (
                <Btn ghost onClick={() => props.onMakeTask(task.id, f.id)}>
                  Make it a task
                </Btn>
              ) : (
                <span className="cs-lbl"> made {f.task}</span>
              )}
            </div>
          ))}
          {task.doneWhen !== undefined && (
            <div className="cs-q">
              <span className="cs-lbl">Done when</span>
              {task.doneWhen}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** A row in a rail (Up next, Ideas, Done today): one line, and its details when it is open. */
const RowView = memo(function RowView(props: RowProps) {
  const { entry, selected, now, hues, nowLine } = props;
  const { task, state, rail } = entry;
  const lamp = state === undefined ? (rail === "done" ? "done" : "idle") : WORK_STATE_LAMP[state];
  const kase = task.case;
  const prefix = kase !== undefined ? kase.client : projectOf(task) || workspaceName(props.orgs, task.org);
  const summaryLines = (kase?.summary ?? "").split("\n").filter((l) => l.trim() !== "");
  const gist =
    kase !== undefined
      ? undefined
      : (nowLine ??
        (rail === "queued" ? props.waitsOn : undefined) ??
        (rail === "queued"
          ? "Starts when a slot frees"
          : rail === "ideas"
            ? "Waits for you to start it"
            : undefined));
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the console takes the keys itself (J, K, A, Enter)
    <div
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-label={`${projectOf(task)} ${nameOf(task)}`}
      className={rail === "done" && kase === undefined ? "cs-row cs-done" : "cs-row"}
      data-task={task.id}
      style={wsStyle(hues, task.org)}
      onClick={() => props.onSelect(entryKey(entry))}
    >
      {rail === "done" ? (
        <span className="cs-tick" aria-hidden="true">
          ✓
        </span>
      ) : (
        <ConsoleLamp state={lamp} />
      )}
      <div className="cs-main-line">
        <RowTitle prefix={prefix} name={nameOf(task)} />
        {kase === undefined && (
          <span className="cs-gist">{gist ?? <span className="cs-unset">No status yet</span>}</span>
        )}
      </div>
      <div className="cs-end">
        {props.unread > 0 && <span className="cs-unread">{props.unread}</span>}
        {rail === "done" ? (
          <span className="cs-age">{ageWord(task.updatedAt, now)}</span>
        ) : (
          <span className="cs-st" data-tone="idle">
            {railWord(rail ?? "queued")}
          </span>
        )}
      </div>
      {kase !== undefined && rail === "done" && (
        <div className="cs-case">
          <div className="cs-case-line">{summaryLines[0] ?? "Closed"}</div>
        </div>
      )}
      {selected && (
        <div className="cs-det">
          {kase !== undefined && summaryLines.length > 0 && (
            <div className="cs-q" data-full="true">
              {kase.summary}
            </div>
          )}
          {kase?.followUps.map((f) => (
            <div key={f.id} className="cs-q">
              <span className="cs-lbl">Follow-up</span>
              {f.text}
              {f.task === undefined ? (
                <Btn ghost onClick={() => props.onMakeTask(task.id, f.id)}>
                  Make it a task
                </Btn>
              ) : (
                <span className="cs-lbl"> made {f.task}</span>
              )}
            </div>
          ))}
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
  askOf: (task: TaskSummary) => string | undefined;
  doingOf: (task: TaskSummary) => Doing | undefined;
  buttonsOf: (entry: WorkEntry) => readonly ActionDef[] | undefined;
  /** Home has no project yet: the pane says so and offers to add one. */
  noProject?: boolean;
  onAddProject?: () => void;
  onMakeTask: (task: string, followUp: string) => void;
  actions: readonly ActionDef[] | undefined;
  onSelect: (key: string) => void;
  onToggleOrg: (org: string) => void;
  onUnfold: (key: string) => void;
  onToggleRail: (id: RailId) => void;
  onNewTask: () => void;
  onFocus: () => void;
  onMinimize: () => void;
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
          <MinimizeButton name="Work" keys="Shift+2" onClick={props.onMinimize} />
        </div>
      </div>
      <div className="cs-rule" />
      {props.noProject === true && (
        <div className="cs-addproj">
          <span>No project yet. Agents work only in projects you add.</span>
          <Btn primary onClick={() => props.onAddProject?.()}>
            Add a project
          </Btn>
        </div>
      )}
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
              const View = item.entry.rail === undefined ? CardView : RowView;
              return (
                <View
                  entry={item.entry}
                  selected={selected}
                  now={props.now}
                  unread={props.unreadOf(item.entry.task.id)}
                  hues={props.hues}
                  orgs={props.orgs}
                  nowLine={props.nowLineOf(item.entry.task)}
                  waitsOn={props.waitsOnOf(item.entry.task)}
                  ask={props.askOf(item.entry.task)}
                  doing={props.doingOf(item.entry.task)}
                  buttons={props.buttonsOf(item.entry)}
                  actions={selected ? props.actions : undefined}
                  onSelect={props.onSelect}
                  onMakeTask={props.onMakeTask}
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
