import {
  type DecisionDetail,
  type OwnerDecision,
  QUEUE_GROUP_LABEL,
  QUEUE_GROUP_SHOWN,
  type QueueGroup,
} from "@majhi/shared";
import { memo, useEffect, useRef, useState } from "react";
import { ageWord } from "./model";
import type { Needs, NeedsRow } from "./needs-model";
import { type PaneItem, PaneList } from "./pane-list";
import { Btn, Chevron, ConsoleLamp, Kbd, MinimizeButton, RowTitle, wsStyle } from "./parts";

export interface ActionDef {
  id: string;
  label: string;
  run: () => void;
  primary?: boolean;
  ghost?: boolean;
  /** The answer needs typed words: the row opens a box instead of sending. */
  typed?: boolean;
}

type Item =
  | (PaneItem & { type: "head"; group: QueueGroup; count: number; closed: boolean })
  | (PaneItem & { type: "row"; row: NeedsRow })
  | (PaneItem & { type: "more"; group: QueueGroup; hidden: number });

/** The list items of the pane, in the order they are shown. The selectable rows are the `row` items. */
export function needsItems(
  needs: Needs,
  shown: Readonly<Record<QueueGroup, number>>,
  closed: ReadonlySet<QueueGroup>,
): Item[] {
  const out: Item[] = [];
  for (const group of ["incident", "decide", "review", "captain"] as const) {
    const rows = needs[group];
    if (rows.length === 0) continue;
    const isClosed = closed.has(group);
    out.push({ key: `h:${group}`, type: "head", group, count: rows.length, closed: isClosed });
    if (isClosed) continue;
    for (const row of rows.slice(0, shown[group])) out.push({ key: row.id, type: "row", row });
    if (rows.length > shown[group]) {
      out.push({ key: `m:${group}`, type: "more", group, hidden: rows.length - shown[group] });
    }
  }
  return out;
}

export function initialShown(): Record<QueueGroup, number> {
  return { ...QUEUE_GROUP_SHOWN };
}

const MORE_STEP = 1000;

export function showMore(shown: Record<QueueGroup, number>, group: QueueGroup): Record<QueueGroup, number> {
  return { ...shown, [group]: shown[group] + MORE_STEP };
}

/** The one decision a row answers, when it does not merge repeats. */
function onlyOf(row: NeedsRow): OwnerDecision | undefined {
  return row.decisions.length === 1 ? row.decisions[0] : undefined;
}

/** A question with answers is drawn as a numbered list of choices, each one whole. */
export function isChoiceCard(row: NeedsRow): boolean {
  const only = onlyOf(row);
  return only !== undefined && only.kind === "question" && only.options.length > 0;
}

/**
 * What the card says. A question is the question itself, from the detail's typed `questions` (the
 * decision's own sentence names the agent first, and the agent is shown elsewhere). It waits for the
 * detail rather than showing the sentence for a moment and then another text.
 */
function bodyOf(row: NeedsRow, only: OwnerDecision | undefined, detail: DecisionDetail | undefined) {
  const gist = row.gist === "" ? undefined : row.gist;
  if (only === undefined) return gist;
  if (only.kind !== "question") {
    if (only.sentence === undefined) return gist;
    return only.sentence !== row.name ? only.sentence : undefined;
  }
  if (detail?.id !== only.id) return undefined;
  return detail.questions?.[0]?.question ?? only.sentence ?? gist;
}

function Detail({ row, detail }: { row: NeedsRow; detail: DecisionDetail | undefined }) {
  const only = onlyOf(row);
  // The agent's own suggestion is marked on its choice; only the captain's reasoning is worth a sentence.
  const suggested =
    only?.suggestion === undefined || only.suggestion.by !== "captain" || isChoiceCard(row)
      ? undefined
      : `Captain suggests ${
          only.options.find((o) => o.id === only.suggestion?.option)?.label ?? only.suggestion.option
        }${only.suggestion.reason === "" ? "" : `: ${only.suggestion.reason}`}`;
  const body = bodyOf(row, only, detail);
  const diff = detail?.diff;
  return (
    <>
      {body !== undefined && <div className="cs-q">{body}</div>}
      {detail?.command !== undefined && (
        <div className="cs-q" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {detail.command}
        </div>
      )}
      {diff !== undefined && diff.error === undefined && (
        <div className="cs-list">
          {diff.files} {diff.files === 1 ? "file" : "files"}, +{diff.additions} −{diff.deletions}
          {diff.uncommitted ? ", not all committed" : ""}
        </div>
      )}
      {detail?.checks !== undefined && <div className="cs-list">{detail.checks}</div>}
      {suggested !== undefined && <div className="cs-list">{suggested}</div>}
      {row.list !== undefined && <div className="cs-list">{row.list}</div>}
    </>
  );
}

function ReplyBox({ onSend, onCancel }: { onSend: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <textarea
        ref={field}
        aria-label="Your reply"
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && !event.shiftKey && text.trim() !== "") {
            event.preventDefault();
            event.stopPropagation();
            onSend(text.trim());
          }
        }}
        className="w-full resize-none rounded-md border border-line-control bg-field px-2 py-1.5 text-base text-fg outline-none focus:border-accent"
      />
      <div className="cs-acts" style={{ marginTop: 0 }}>
        <Btn primary disabled={text.trim() === ""} onClick={() => onSend(text.trim())}>
          Send
        </Btn>
        <Btn ghost onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/**
 * The answers of a question, stacked and numbered, each in full width with its text whole. A row
 * chooses on a click or its number key. The suggested one is marked and carries the filled button.
 */
function Choices(props: {
  decision: OwnerDecision | undefined;
  picks: readonly ActionDef[];
  replying: boolean;
  onReplySend: (text: string) => void;
  onReplyCancel: () => void;
}) {
  const suggestion = props.decision?.suggestion;
  return (
    <fieldset className="cs-choices">
      <legend className="sr-only">Answers</legend>
      {props.picks.map((a, i) => {
        if (a.typed === true && props.replying) {
          return (
            <div key={a.id} className="cs-choice" data-open>
              <span className="cs-num">{i + 1}</span>
              <div className="cs-ctext">
                <ReplyBox onSend={props.onReplySend} onCancel={props.onReplyCancel} />
              </div>
            </div>
          );
        }
        const suggested = suggestion?.option === a.id;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the console takes the number keys itself
          // biome-ignore lint/a11y/useSemanticElements: it holds a button of its own, which a <button> cannot
          <div
            key={a.id}
            role="button"
            tabIndex={-1}
            className="cs-choice cs-needsable"
            data-suggested={suggested || undefined}
            data-pick={i + 1}
            onClick={(event) => {
              event.stopPropagation();
              a.run();
            }}
          >
            <span className="cs-num">{i + 1}</span>
            <span className="cs-ctext">
              {a.label}
              {a.typed === true ? "…" : ""}
            </span>
            {(a.primary === true || suggested) && (
              <div className="cs-cmeta">
                {suggested && <span className="cs-tag">suggested</span>}
                {suggested && suggestion?.by === "captain" && suggestion.reason !== "" && (
                  <span className="cs-why">{suggestion.reason}</span>
                )}
                {a.primary === true && (
                  <Btn primary keyHint="A" onClick={a.run}>
                    Choose
                  </Btn>
                )}
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

interface RowProps {
  row: NeedsRow;
  selected: boolean;
  isNew: boolean;
  now: number;
  hues: ReadonlyMap<string, number>;
  actions: readonly ActionDef[] | undefined;
  detail: DecisionDetail | undefined;
  replying: boolean;
  onSelect: (id: string) => void;
  onQuick: (id: string) => void;
  onReplySend: (text: string) => void;
  onReplyCancel: () => void;
}

const RowView = memo(function RowView(props: RowProps) {
  const { row, selected, isNew, now, hues, actions, detail, replying } = props;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the console takes the keys itself (J, K, A, Enter)
    <div
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      className="cs-row"
      data-incident={row.incident || undefined}
      data-new={isNew || undefined}
      data-row={row.id}
      style={wsStyle(hues, row.org)}
      onClick={() => props.onSelect(row.id)}
    >
      <ConsoleLamp state={row.lamp} />
      <div className="cs-main-line">
        <RowTitle prefix={row.prefix} name={row.name} />
        <span className="cs-gist">{row.gist}</span>
      </div>
      <div className="cs-end">
        {row.count > 1 && <span className="cs-count">×{row.count}</span>}
        <span className="cs-age">{ageWord(row.at, now)}</span>
        {!selected && (
          <Btn primary className="cs-quick cs-needsable" onClick={() => props.onQuick(row.id)}>
            {row.quick}
          </Btn>
        )}
      </div>
      {selected && (
        <div className="cs-det">
          <Detail row={row} detail={detail} />
          {isChoiceCard(row) ? (
            <>
              <Choices
                decision={row.decisions[0]}
                picks={(actions ?? []).filter((a) => a.ghost !== true)}
                replying={replying}
                onReplySend={props.onReplySend}
                onReplyCancel={props.onReplyCancel}
              />
              <div className="cs-acts">
                {(actions ?? [])
                  .filter((a) => a.ghost === true)
                  .map((a) => (
                    <Btn key={a.id} ghost className="cs-needsable" onClick={a.run}>
                      {a.label}
                    </Btn>
                  ))}
              </div>
            </>
          ) : replying ? (
            <ReplyBox onSend={props.onReplySend} onCancel={props.onReplyCancel} />
          ) : (
            <div className="cs-acts">
              {actions?.map((a, i) => (
                <Btn
                  key={a.id}
                  primary={a.primary === true}
                  ghost={a.ghost === true}
                  className="cs-needsable"
                  keyHint={a.primary === true ? "A" : undefined}
                  onClick={a.run}
                  data-pick={a.ghost === true ? undefined : i + 1}
                >
                  {a.label}
                </Btn>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export function NeedsPane(props: {
  needs: Needs;
  shown: Record<QueueGroup, number>;
  closed: ReadonlySet<QueueGroup>;
  selectedId: string | undefined;
  focus: boolean;
  total: number;
  loading: boolean;
  now: number;
  hues: ReadonlyMap<string, number>;
  offline: boolean;
  arrived: ReadonlySet<string>;
  selectedActions: readonly ActionDef[] | undefined;
  detail: DecisionDetail | undefined;
  replyingId: string | undefined;
  oldestFirst: boolean;
  lastAnswered: string | undefined;
  onSelect: (id: string) => void;
  onQuick: (id: string) => void;
  onToggle: (group: QueueGroup) => void;
  onMore: (group: QueueGroup) => void;
  onReplySend: (text: string) => void;
  onReplyCancel: () => void;
  onFocus: () => void;
  onMinimize: () => void;
}) {
  const items = needsItems(props.needs, props.shown, props.closed);
  return (
    <section
      className="cs-pane cs-glass"
      data-pane="needs"
      data-focus={props.focus}
      aria-label="Needs you"
      onMouseDownCapture={props.onFocus}
    >
      {props.offline && (
        <div className="cs-banner" role="status">
          <ConsoleLamp state="paused" />
          Offline. Reconnecting. Answers wait until majhi is back.
        </div>
      )}
      <div className="cs-phead">
        <ConsoleLamp state="needs" dim={props.total === 0} />
        <h2>Needs you</h2>
        <span className="cs-sub">
          {props.total > 0 && (
            <>
              <b>{props.total}</b>, oldest first
            </>
          )}
        </span>
        <div className="cs-right">
          <MinimizeButton name="Needs you" keys="Shift+1" onClick={props.onMinimize} />
        </div>
      </div>
      <div className="cs-rule" />
      {items.length === 0 ? (
        <div className="cs-scroll" aria-busy={props.loading}>
          {!props.loading && (
            <div className="cs-empty">
              <b>
                <ConsoleLamp state="done" />
                All clear
              </b>
              {props.lastAnswered === undefined
                ? "Nothing waits for you."
                : `Nothing waits for you. ${props.lastAnswered}`}
            </div>
          )}
        </div>
      ) : (
        <PaneList
          items={items}
          label="Needs you"
          selectedKey={props.selectedId}
          render={(item) => {
            if (item.type === "head") {
              return (
                <button
                  type="button"
                  className="cs-gh"
                  aria-expanded={!item.closed}
                  onClick={() => props.onToggle(item.group)}
                >
                  {QUEUE_GROUP_LABEL[item.group]} <span className="cs-n">{item.count}</span>
                  <Chevron />
                </button>
              );
            }
            if (item.type === "more") {
              return (
                <button type="button" className="cs-more" onClick={() => props.onMore(item.group)}>
                  Show {item.hidden} more {QUEUE_GROUP_LABEL[item.group].toLowerCase()}
                </button>
              );
            }
            const selected = props.focus && props.selectedId === item.row.id;
            return (
              <RowView
                row={item.row}
                selected={selected}
                isNew={props.arrived.has(item.row.id)}
                now={props.now}
                hues={props.hues}
                actions={selected ? props.selectedActions : undefined}
                detail={selected ? props.detail : undefined}
                replying={selected && props.replyingId === item.row.id}
                onSelect={props.onSelect}
                onQuick={props.onQuick}
                onReplySend={props.onReplySend}
                onReplyCancel={props.onReplyCancel}
              />
            );
          }}
        />
      )}
      <div className="cs-foot">
        <span>
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> move
        </span>
        <span>
          <Kbd>A</Kbd> do it
        </span>
        <span>
          <Kbd>1</Kbd>
          <Kbd>…</Kbd>
          <Kbd>9</Kbd> pick
        </span>
        <span>
          <Kbd>⇧A</Kbd> whole group
        </span>
        <span>
          <Kbd>E</Kbd> later
        </span>
        <span>
          <Kbd>U</Kbd> undo
        </span>
      </div>
    </section>
  );
}
