import { DECISION_KIND_LABEL, type OwnerDecisionKind } from "@majhi/shared";
import { ChevronRight } from "lucide-react";
import { memo, type ReactNode, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { OrgBadge } from "@/components/ui/org-badge";
import { rowTitle } from "@/features/decisions/model";
import { useHeldOption } from "@/features/decisions/use-send-decision";
import { cn } from "@/lib/cn";
import { openDue, shortAgo } from "../tasks/schedule";
import { DueChip, PriorityChip } from "../tasks/schedule-chips";
import {
  type ActionSpec,
  actionsOf,
  blockerText,
  type DoneItem,
  decisionTitle,
  type Entry,
  type NeedsItem,
  type QueuedItem,
  queuedChip,
  type RowEntry,
  type RunningItem,
  SECTION_LABEL,
  SECTION_SORT,
  type SectionId,
  type ShippingItem,
} from "./home-model";
import { plainTitle } from "./model";

/** What every row of the list shares: the focus, the selection, the clock, and the three callbacks. */
export interface RowHandlers {
  onFocus: (key: string) => void;
  onAct: (key: string, index: number) => void;
  onOpen: (key: string) => void;
  onToggle: (section: SectionId) => void;
  onMore: (section: SectionId) => void;
}

interface RowProps extends Pick<RowHandlers, "onFocus" | "onAct" | "onOpen"> {
  entryKey: string;
  focused: boolean;
  selected: boolean;
  now: number;
}

/** A workspace as its colored tile and name; below 1280px only the tile. */
export interface OrgTag {
  name: string;
  letters: string;
  color: string | undefined;
}

function OrgChip({ org }: { org: OrgTag }) {
  return (
    <span
      title={org.name}
      className="flex shrink-0 items-center gap-1.5 text-xs text-fg-soft min-[1280px]:w-[104px]"
    >
      <OrgBadge label={org.letters} color={org.color} size="xs" />
      <span className="min-w-0 truncate max-[1279px]:hidden">{org.name}</span>
    </span>
  );
}

export function rowDomId(key: string): string {
  return `home-row-${key}`;
}

const VERB_BY_KIND: Record<OwnerDecisionKind, string> = {
  question: "Answer",
  approval: "Approve",
  ship: "Review",
  budget: "Budget",
  paused: "Unblock",
  "sign-in": "Sign in",
  secret: "Secret",
  draft: "Review",
  batch: "Review",
  incident: "Incident",
  trust: "Trust",
  notifications: "Turn on",
};

/**
 * One line: lamp, kind, id, title, workspace, the detail, the wait and the primary button. Below 1280px
 * the detail and the other numbered buttons drop to a second line, and only for the row the keys are on.
 * The wait and the primary button stay on the first line, at the right.
 */
function Row({
  entryKey,
  focused,
  selected,
  lamp,
  chip,
  chipTone,
  id,
  title,
  org,
  detail,
  wait,
  actions,
  primaryTone = "secondary",
  busy = false,
  onFocus,
  onAct,
  onOpen,
}: Pick<RowProps, "entryKey" | "focused" | "selected" | "onFocus" | "onAct" | "onOpen"> & {
  lamp: LampState;
  chip: string;
  chipTone?: LampState | undefined;
  id: string | undefined;
  title: string;
  org: OrgTag | undefined;
  detail: ReactNode;
  wait: string;
  actions: readonly ActionSpec[];
  primaryTone?: "primary" | "secondary";
  busy?: boolean;
}) {
  const [first, ...others] = actions;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row only takes the keys' place on a press; its buttons do the work
    <div
      id={rowDomId(entryKey)}
      data-home-row={entryKey}
      aria-current={focused ? "true" : undefined}
      onMouseDown={() => onFocus(entryKey)}
      className={cn(
        "group relative flex flex-wrap items-center gap-x-3 border-b border-line px-3 text-base",
        "min-h-9 py-1 transition-colors duration-100",
        focused ? "bg-selected" : "hover:bg-raised",
        selected && "bg-accent-wash",
        "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:content-['']",
        focused && "before:bg-accent",
      )}
    >
      <span className="flex h-7 items-center">
        <Lamp state={lamp} size={7} />
      </span>
      <span
        className={cn(
          "w-[66px] shrink-0 truncate text-xs font-medium",
          chipTone === undefined ? "text-fg-muted" : LAMP_TEXT[chipTone],
        )}
      >
        {chip}
      </span>
      <span className="w-[62px] shrink-0 truncate font-mono text-xs text-fg-faint">{id ?? ""}</span>
      <button
        type="button"
        onClick={() => onOpen(entryKey)}
        title={title}
        className="m-0 min-w-0 flex-[2] cursor-pointer truncate p-0 text-left text-base font-medium text-fg outline-none hover:underline focus-visible:underline"
      >
        {title}
      </button>
      {org !== undefined ? (
        <OrgChip org={org} />
      ) : (
        <span className="w-[18px] shrink-0 min-[1280px]:w-[104px]" />
      )}
      <span
        className={cn(
          "flex min-w-0 flex-[3] items-center gap-2",
          focused
            ? "max-[1279px]:order-last max-[1279px]:basis-full max-[1279px]:pb-1 max-[1279px]:pl-[93px]"
            : "max-[1279px]:hidden",
        )}
      >
        <span className="min-w-0 truncate text-sm text-fg-soft">{detail}</span>
        {others.length > 0 && (
          <span
            className={cn(
              "ml-auto shrink-0 items-center gap-1",
              focused ? "flex" : "hidden group-hover:flex",
            )}
          >
            {others.map((spec, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: the number is the identity of an action
                key={i}
                type="button"
                onClick={() => onAct(entryKey, i + 1)}
                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
              >
                <Kbd className="h-4 min-w-4 text-[10px]">{i + 2}</Kbd>
                {spec.label}
              </button>
            ))}
          </span>
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <span className="tnum w-9 text-right font-mono text-xs text-fg-faint">{wait}</span>
        {first !== undefined && (
          <Button
            size="sm"
            variant={primaryTone}
            disabled={busy}
            onClick={() => onAct(entryKey, 0)}
            className="max-w-[168px] min-w-[84px] justify-center"
          >
            {focused && <Kbd className="h-4 min-w-4 text-[10px]">1</Kbd>}
            <span className="truncate">{busy ? "Sending..." : first.label}</span>
          </Button>
        )}
      </span>
    </div>
  );
}

// Needs you -----------------------------------------------------------------

const NeedsRow = memo(function NeedsRow({
  item,
  org,
  entryKey,
  ...rest
}: { item: NeedsItem; org: OrgTag | undefined } & RowProps) {
  const d = item.decision;
  const ship = d.kind === "ship";
  const held = useHeldOption(d.id);
  // The list says when the main action cannot succeed; Home never reads a decision's detail.
  const blocked = useMemo(
    () =>
      d.blocked === undefined ? undefined : Object.fromEntries(d.options.map((o) => [o.id, d.blocked ?? ""])),
    [d.blocked, d.options],
  );
  const actions = actionsOf({ type: "needs", key: entryKey, section: "needs", item }, () => blocked);
  const text: ReactNode = ship ? (
    d.blocked !== undefined ? (
      <span className="text-caution">{d.blocked}</span>
    ) : (
      (d.sentence ?? "Ready to ship")
    )
  ) : d.kind === "question" || d.kind === "approval" ? (
    rowTitle(d)
  ) : (
    (d.blocked ?? d.sentence ?? d.title)
  );
  const title = d.task === undefined ? d.title : decisionTitle(d);
  return (
    <Row
      {...rest}
      entryKey={entryKey}
      lamp={d.kind === "paused" ? "paused" : "needs"}
      chip={
        d.kind === "question" ? VERB_BY_KIND.question : (VERB_BY_KIND[d.kind] ?? DECISION_KIND_LABEL[d.kind])
      }
      chipTone="needs"
      id={d.task}
      title={title}
      org={org}
      detail={text}
      wait={shortAgo(d.at, rest.now)}
      actions={actions}
      primaryTone="primary"
      busy={held !== undefined}
    />
  );
});

// Running now ---------------------------------------------------------------

function elapsed(iso: string | undefined, now: number): string {
  return iso === undefined ? "" : shortAgo(iso, now);
}

const RunningRow = memo(function RunningRow({
  item,
  org,
  entryKey,
  ...rest
}: { item: RunningItem; org: OrgTag | undefined } & RowProps) {
  const { task, doing, paused } = item;
  const kids = task.children === undefined ? "" : ` · ${task.children.done} of ${task.children.total} done`;
  const who = task.autonomous === true ? "captain" : "you";
  const text = paused
    ? "Paused, no agent is working on it"
    : `${who} · @${doing?.agent ?? task.working[0] ?? task.team[0] ?? "agent"}${doing?.text === undefined ? "" : ` "${doing.text}"`}${kids}`;
  return (
    <Row
      {...rest}
      entryKey={entryKey}
      lamp={paused ? "paused" : "working"}
      chip={paused ? "Paused" : "Running"}
      chipTone={paused ? "paused" : "working"}
      id={task.id}
      title={plainTitle(task.title)}
      org={org}
      detail={text}
      wait={elapsed(doing?.since ?? task.updatedAt, rest.now)}
      actions={actionsOf({ type: "running", key: entryKey, section: "running", item })}
    />
  );
});

// Shipping ------------------------------------------------------------------

const CI_WORDS = {
  failing: "CI failed",
  pending: "CI running",
  passing: "CI passed",
  none: "No CI",
} as const;

const ShippingRow = memo(function ShippingRow({
  item,
  org,
  entryKey,
  ...rest
}: { item: ShippingItem; org: OrgTag | undefined } & RowProps) {
  const { task, mr, extra } = item;
  const ci = mr?.ci;
  const lamp: LampState =
    ci === "failing" ? "needs" : ci === "pending" ? "working" : ci === "passing" ? "done" : "idle";
  const who =
    ci === "failing"
      ? ""
      : task.autonomous === true
        ? ci === "passing"
          ? " · the captain merges it"
          : " · the captain merges when green"
        : ci === "passing"
          ? " · ready for you to merge"
          : "";
  const text =
    mr === undefined
      ? "Merge request open"
      : `!${mr.number} ${mr.project}${extra > 0 ? ` +${extra}` : ""} · ${CI_WORDS[mr.ci]}${who}`;
  return (
    <Row
      {...rest}
      entryKey={entryKey}
      lamp={lamp}
      chip={ci === "failing" ? "Failed" : "MR open"}
      chipTone={ci === "failing" ? "needs" : undefined}
      id={task.id}
      title={plainTitle(task.title)}
      org={org}
      detail={text}
      wait={shortAgo(task.updatedAt, rest.now)}
      actions={actionsOf({ type: "shipping", key: entryKey, section: "shipping", item })}
    />
  );
});

// Up next and To triage -----------------------------------------------------

const QueuedRow = memo(function QueuedRow({
  item,
  org,
  entryKey,
  type,
  orgName,
  ...rest
}: {
  item: QueuedItem;
  org: OrgTag | undefined;
  type: "next" | "triage";
  orgName: (id: string) => string;
} & RowProps) {
  const { task, blocker } = item;
  const due = openDue(task, rest.now);
  const priority = task.priority !== undefined && task.priority !== "normal" ? task.priority : undefined;
  const text =
    task.status === "review"
      ? "Finished, nothing waits on you. Mark it done or reply"
      : task.status === "running" || task.status === "paused"
        ? task.children === undefined
          ? "No agent is working on it"
          : `Waits on its subtasks (${task.children.done} of ${task.children.total} done)`
        : blockerText(blocker, orgName);
  return (
    <Row
      {...rest}
      entryKey={entryKey}
      lamp="idle"
      chip={
        task.status === "review"
          ? "finished"
          : task.status === "ready" || task.status === "inbox"
            ? queuedChip(blocker)
            : "idle"
      }
      id={task.id}
      title={plainTitle(task.title)}
      org={org}
      detail={
        <span className="inline-flex min-w-0 items-center gap-2">
          {priority && <PriorityChip priority={priority} compact />}
          {due && <DueChip due={due} short />}
          <span className="truncate">{text}</span>
        </span>
      }
      wait={shortAgo(task.updatedAt, rest.now)}
      actions={actionsOf(
        type === "next"
          ? { type, key: entryKey, section: type, item }
          : { type, key: entryKey, section: type, item },
      )}
    />
  );
});

// Captain handled and Done today ---------------------------------------------

const CaptainRow = memo(function CaptainRow({
  item,
  org,
  entryKey,
  ...rest
}: { item: Extract<RowEntry, { type: "captain" }>["item"]; org: OrgTag | undefined } & RowProps) {
  return (
    <Row
      {...rest}
      entryKey={entryKey}
      lamp="done"
      chip="Captain"
      id={item.task}
      title={item.text}
      org={org}
      detail={item.evidence ?? item.reason}
      wait={shortAgo(item.at, rest.now)}
      actions={actionsOf({ type: "captain", key: entryKey, section: "captain", item })}
    />
  );
});

const DoneRow = memo(function DoneRow({
  item,
  org,
  entryKey,
  ...rest
}: { item: DoneItem; org: OrgTag | undefined } & RowProps) {
  return (
    <Row
      {...rest}
      entryKey={entryKey}
      lamp="done"
      chip="Done"
      id={item.task.id}
      title={plainTitle(item.task.title)}
      org={org}
      detail={item.undoId === undefined ? "" : "Merged by the captain"}
      wait={new Date(item.task.updatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}
      actions={actionsOf({ type: "done", key: entryKey, section: "done", item })}
    />
  );
});

// Headers and "+n more" -----------------------------------------------------

const HEADER_LAMP: Record<SectionId, LampState> = {
  needs: "needs",
  running: "working",
  shipping: "done",
  next: "idle",
  triage: "idle",
  captain: "done",
  done: "done",
};

export const SectionHeader = memo(function SectionHeader({
  entry,
  focused,
  onToggle,
  onFocus,
}: {
  entry: Extract<Entry, { type: "header" }>;
  focused: boolean;
  onToggle: (section: SectionId) => void;
  onFocus: (key: string) => void;
}) {
  const label = SECTION_LABEL[entry.section];
  const inner = (
    <>
      {entry.collapsible ? (
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-fg-faint transition-transform", entry.open && "rotate-90")}
        />
      ) : (
        <Lamp state={HEADER_LAMP[entry.section]} size={7} />
      )}
      <h2 className="text-[11px] font-medium tracking-[0.08em] text-fg-soft uppercase">{label}</h2>
      <span className="tnum font-mono text-xs text-fg-muted">{entry.count}</span>
      {entry.extra !== undefined && <span className="text-xs text-fg-faint">{entry.extra}</span>}
      {entry.open && (
        <span className="ml-auto truncate text-xs text-fg-faint max-[1279px]:hidden">
          sort: {SECTION_SORT[entry.section]}
        </span>
      )}
    </>
  );
  const frame = cn(
    "flex h-8 w-full items-center gap-2 border-b border-line px-3 text-left",
    focused && "bg-selected",
  );
  return entry.collapsible ? (
    <button
      type="button"
      id={rowDomId(entry.key)}
      aria-expanded={entry.open}
      onClick={() => {
        onFocus(entry.key);
        onToggle(entry.section);
      }}
      className={cn(frame, "cursor-pointer hover:bg-raised")}
    >
      {inner}
    </button>
  ) : (
    <div id={rowDomId(entry.key)} className={cn(frame, "mt-1")}>
      {inner}
    </div>
  );
});

export const MoreRow = memo(function MoreRow({
  entry,
  focused,
  onMore,
  onFocus,
}: {
  entry: Extract<Entry, { type: "more" }>;
  focused: boolean;
  onMore: (section: SectionId) => void;
  onFocus: (key: string) => void;
}) {
  return (
    <button
      type="button"
      id={rowDomId(entry.key)}
      onClick={() => {
        onFocus(entry.key);
        onMore(entry.section);
      }}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center border-b border-line px-3 pl-[93px] text-left text-sm text-fg-muted hover:bg-raised hover:text-fg",
        focused && "bg-selected",
      )}
    >
      +{entry.hidden} more
    </button>
  );
});

// One entry -----------------------------------------------------------------

/** Draws any entry of the list. Everything it passes down is stable, so a row renders again only for its own change. */
export function EntryView({
  entry,
  focusKey,
  selectedKeys,
  now,
  orgLabel,
  orgName,
  handlers,
}: {
  entry: Entry;
  focusKey: string | undefined;
  selectedKeys: ReadonlySet<string>;
  now: number;
  orgLabel: (entry: Entry) => OrgTag | undefined;
  orgName: (id: string) => string;
  handlers: RowHandlers;
}) {
  const focused = entry.key === focusKey;
  if (entry.type === "header")
    return (
      <SectionHeader
        entry={entry}
        focused={focused}
        onToggle={handlers.onToggle}
        onFocus={handlers.onFocus}
      />
    );
  if (entry.type === "more")
    return <MoreRow entry={entry} focused={focused} onMore={handlers.onMore} onFocus={handlers.onFocus} />;
  const common = {
    entryKey: entry.key,
    focused,
    selected: selectedKeys.has(entry.key),
    now,
    org: orgLabel(entry),
    onFocus: handlers.onFocus,
    onAct: handlers.onAct,
    onOpen: handlers.onOpen,
  };
  switch (entry.type) {
    case "needs":
      return <NeedsRow {...common} item={entry.item} />;
    case "running":
      return <RunningRow {...common} item={entry.item} />;
    case "shipping":
      return <ShippingRow {...common} item={entry.item} />;
    case "next":
    case "triage":
      return <QueuedRow {...common} item={entry.item} type={entry.type} orgName={orgName} />;
    case "captain":
      return <CaptainRow {...common} item={entry.item} />;
    case "done":
      return <DoneRow {...common} item={entry.item} />;
  }
}
