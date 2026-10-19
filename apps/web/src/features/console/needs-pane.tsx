import {
  type DecisionDetail,
  QUEUE_GROUP_LABEL,
  QUEUE_GROUP_SHOWN,
  type QueueGroup,
} from "@majhi/shared";
import { memo, useEffect, useRef, useState } from "react";
import { ageWord } from "./model";
import type { Needs, NeedsRow } from "./needs-model";
import { PaneList, type PaneItem } from "./pane-list";
import { Btn, Chevron, ConsoleLamp, Kbd, RowTitle, wsStyle } from "./parts";

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

function Detail({ row, detail }: { row: NeedsRow; detail: DecisionDetail | undefined }) {
  const only = row.decisions.length === 1 ? row.decisions[0] : undefined;
  const suggested =
    only?.suggestion === undefined
      ? undefined
      : `${only.suggestion.by === "captain" ? "Captain suggests" : "The agent suggests"} ${
          only.options.find((o) => o.id === only.suggestion?.option)?.label ?? only.suggestion.option
        }${only.suggestion.reason === "" ? "" : `: ${only.suggestion.reason}`}`;
  const sentence = only?.sentence;
  const diff = detail?.diff;
  return (
    <>
      {sentence !== undefined && sentence !== row.name && <div className="cs-q">{sentence}</div>}
      {sentence === undefined && row.gist !== "" && <div className="cs-q">{row.gist}</div>}
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
          {replying ? (
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
            {props.lastAnswered === undefined ? "Nothing waits for you." : `Nothing waits for you. ${props.lastAnswered}`}
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
          <Kbd>2</Kbd>
          <Kbd>3</Kbd> pick
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
