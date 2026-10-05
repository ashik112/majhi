import { type OrgView, PRIVATE } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Plus, Search, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageLink } from "@/components/ui/page-link";
import { Skeleton } from "@/components/ui/skeleton";
import {
  busiestAccount,
  busiestText,
  USAGE_FULL_PCT,
  USAGE_HIGH_PCT,
  usageTitle,
} from "@/features/accounts/model";
import { MODE_LAMP } from "@/features/autonomy/model";
import { markSeen, useUnseenSummary } from "@/features/autonomy/summary-seen";
import { SpendToday, useAutonomousSwitch } from "@/features/autonomy/switch";
import { summaryLine } from "@/features/captain/summary";
import { workspaceOf } from "@/features/decisions/model";
import { useCaptainLog } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { badgeLetters } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { blockersKey, useBlockers, useHomeFacts } from "@/lib/home-queries";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { useNewTask } from "../new-task/new-task-context";
import { CHORD_MS } from "../shell/shortcuts";
import { useHomeActions } from "./home-actions";
import {
  actionsOf,
  buildEntries,
  buildHome,
  type Entry,
  focusable,
  headerKey,
  jumpSection,
  type RowEntry,
  type SectionId,
  stepFocus,
} from "./home-model";
import { EntryView, type OrgTag, type RowHandlers, rowDomId } from "./home-rows";

/** A list longer than this draws only the rows in view (and a few around them). */
const WINDOW_FROM = 60;
const ROW_ESTIMATE = 37;
const HEADER_ESTIMATE = 33;

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

const isRow = (entry: Entry | undefined): entry is RowEntry =>
  entry !== undefined && entry.type !== "header" && entry.type !== "more";

/** Home: what needs the owner, what runs, what ships, what waits, one line each, in the order of who holds the ball. */
export function BoardScreen() {
  const tasks = useTasks();
  const decisions = useDecisions();
  const orgs = useOrgs().data;
  const { org, setOrg } = useOrgFilter();
  const now = useNow(60_000);
  const log = useCaptainLog(org);
  const blockers = useBlockers();
  const facts = useHomeFacts();
  const { act, open } = useHomeActions();
  const client = useQueryClient();

  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<SectionId>>(new Set());
  const [all, setAll] = useState<ReadonlySet<SectionId>>(new Set());
  const [focusKey, setFocusKey] = useState<string | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const filterRef = useRef<HTMLInputElement>(null);

  const workingTasks = decisions.data?.counts.workingTasks;
  const working = useMemo(() => new Set(workingTasks ?? []), [workingTasks]);
  const captainActions = log.data?.actions;
  const undoOf = useMemo(() => {
    const byTask = new Map<string, number>();
    for (const action of captainActions ?? []) {
      if (action.chore === "ship" && action.outcome === "done" && action.undo === "yes" && action.task) {
        if (!byTask.has(action.task)) byTask.set(action.task, action.id);
      }
    }
    return byTask;
  }, [captainActions]);

  const { sections, totals } = useMemo(
    () =>
      buildHome({
        tasks: tasks.data ?? [],
        decisions: decisions.data?.decisions ?? [],
        working,
        blockers,
        mrs: facts.mrs,
        mrExtra: facts.mrExtra,
        doing: facts.doing,
        captain: captainActions ?? [],
        undoOf,
        org,
        query,
        now,
      }),
    [tasks.data, decisions.data, working, blockers, facts, captainActions, undoOf, org, query, now],
  );
  const entries = useMemo(() => buildEntries(sections, { opened, all }), [sections, opened, all]);
  const entryByKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const focusKeys = useMemo(() => entries.filter(focusable).map((e) => e.key), [entries]);

  const orgNames = useMemo(() => new Map((orgs ?? []).map((o) => [o.id, o.name])), [orgs]);
  const orgName = useCallback((id: string) => orgNames.get(id) ?? id, [orgNames]);
  const orgTags = useMemo(
    () =>
      new Map(
        (orgs ?? []).map((o): [string, OrgTag] => [
          o.id,
          { name: o.name, letters: badgeLetters(o.key), color: o.color },
        ]),
      ),
    [orgs],
  );
  const tagOf = useCallback(
    (id: string): OrgTag => orgTags.get(id) ?? { name: id, letters: badgeLetters(id), color: undefined },
    [orgTags],
  );
  const orgLabel = useCallback(
    (entry: Entry): OrgTag | undefined => {
      switch (entry.type) {
        case "needs": {
          const id = workspaceOf(entry.item.decision);
          return id === undefined ? undefined : tagOf(id);
        }
        case "running":
        case "shipping":
        case "next":
        case "triage":
        case "done":
          return tagOf(entry.item.task.org ?? PRIVATE);
        case "captain":
          return tagOf(entry.item.org);
        default:
          return undefined;
      }
    },
    [tagOf],
  );

  // The mode switch changes what a waiting task says ("Auto-pilot is off"): read the reasons again.
  const { mode } = useAutonomousSwitch();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mode is the trigger, not an input
  useEffect(() => {
    void client.invalidateQueries({ queryKey: blockersKey });
  }, [mode, client]);

  // The row the keys are on leaves (answered, started): the one now in its place takes the keys.
  const lastIndex = useRef(0);
  useEffect(() => {
    if (focusKey === undefined) return;
    const at = focusKeys.indexOf(focusKey);
    if (at >= 0) {
      lastIndex.current = at;
      return;
    }
    setFocusKey(focusKeys[Math.min(lastIndex.current, focusKeys.length - 1)]);
  }, [focusKeys, focusKey]);

  // Selection only holds rows that are still there.
  useEffect(() => {
    if (selected.size === 0) return;
    const live = new Set([...selected].filter((k) => entryByKey.has(k)));
    if (live.size !== selected.size) setSelected(live);
  }, [entryByKey, selected]);

  const toggleSection = useCallback((section: SectionId) => {
    setOpened((prev) => {
      const next = new Set(prev);
      if (!next.delete(section)) next.add(section);
      return next;
    });
  }, []);
  const moreOf = useCallback((section: SectionId) => setAll((prev) => new Set(prev).add(section)), []);

  const live = useRef({ entries, entryByKey, focusKeys, focusKey, selected });
  live.current = { entries, entryByKey, focusKeys, focusKey, selected };

  const runAction = useCallback(
    (key: string, index: number) => {
      const entry = live.current.entryByKey.get(key);
      if (!isRow(entry)) return;
      const spec = actionsOf(entry)[index];
      if (spec !== undefined) act(entry, spec);
    },
    [act],
  );
  const openRow = useCallback(
    (key: string) => {
      const entry = live.current.entryByKey.get(key);
      if (isRow(entry)) open(entry);
    },
    [open],
  );

  const handlers: RowHandlers = useMemo(
    () => ({
      onFocus: setFocusKey,
      onAct: runAction,
      onOpen: openRow,
      onToggle: toggleSection,
      onMore: moreOf,
    }),
    [runAction, openRow, toggleSection, moreOf],
  );

  // Runs the same numbered action on every selected row, in list order.
  const applyToSelected = useCallback(
    (index: number) => {
      const state = live.current;
      for (const entry of state.entries) {
        if (isRow(entry) && state.selected.has(entry.key)) runAction(entry.key, index);
      }
      setSelected(new Set());
    },
    [runAction],
  );

  // Keys -----------------------------------------------------------------------
  const goAt = useRef(0);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('dialog, [role="menu"], [role="listbox"], [data-captain-drawer]')
      )
        return;
      if (typing(target)) return;
      // `g` then a letter goes to a page: the second key is not ours.
      const afterG = Date.now() - goAt.current < CHORD_MS;
      if (event.key === "g") {
        goAt.current = Date.now();
        return;
      }
      if (afterG) {
        goAt.current = 0;
        return;
      }
      const state = live.current;
      const move = (to: string | undefined) => {
        if (to === undefined) return;
        event.preventDefault();
        setFocusKey(to);
      };
      const current = state.focusKey === undefined ? undefined : state.entryByKey.get(state.focusKey);
      const key = event.key;
      if (key === "j" || key === "ArrowDown") move(stepFocus(state.focusKeys, state.focusKey, 1));
      else if (key === "k" || key === "ArrowUp") move(stepFocus(state.focusKeys, state.focusKey, -1));
      else if (key === "J") move(jumpSection(state.entries, state.focusKey, 1));
      else if (key === "K") move(jumpSection(state.entries, state.focusKey, -1));
      else if (key === "/") {
        event.preventDefault();
        filterRef.current?.focus();
      } else if (key === "t") {
        event.preventDefault();
        setOpened((prev) => new Set(prev).add("triage"));
        setFocusKey(headerKey("triage"));
      } else if (key === "Escape") {
        if (state.selected.size > 0) setSelected(new Set());
      } else if (current !== undefined) {
        if (key === "Enter") {
          if (target instanceof HTMLElement && target.closest("button, a, input")) return;
          event.preventDefault();
          if (current.type === "header") {
            if (current.collapsible) toggleSection(current.section);
          } else if (current.type === "more") moreOf(current.section);
          else if (isRow(current)) openRow(current.key);
        } else if (/^[1-3]$/.test(key) && isRow(current)) {
          event.preventDefault();
          if (state.selected.size > 0 && state.selected.has(current.key)) applyToSelected(Number(key) - 1);
          else runAction(current.key, Number(key) - 1);
        } else if ((key === "x" || key === "X") && isRow(current)) {
          event.preventDefault();
          setSelected((prev) => {
            const next = new Set(prev);
            if (!next.delete(current.key)) next.add(current.key);
            return next;
          });
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runAction, openRow, toggleSection, moreOf, applyToSelected]);

  // The first row of a section: the strip and the chips send the keys there.
  const jumpTo = useCallback((section: SectionId) => {
    if (section === "triage" || section === "captain" || section === "done")
      setOpened((prev) => new Set(prev).add(section));
    const first = live.current.entries.find((e) => e.section === section && focusable(e));
    setFocusKey(first?.key ?? headerKey(section));
  }, []);

  const loading = tasks.isPending || decisions.isPending;
  const quiet =
    totals.needs + totals.running + totals.shipping + totals.next + totals.triage === 0 && query === "";
  const orgCounts = useChipCounts(tasks.data, decisions.data?.decisions, decisions.data?.counts.orgs);

  const batch = useMemo(() => {
    const picked = entries.filter((e): e is RowEntry => isRow(e) && selected.has(e.key));
    const labels = new Set(picked.map((e) => actionsOf(e)[0]?.label));
    return { count: picked.length, label: labels.size === 1 ? [...labels][0] : undefined };
  }, [entries, selected]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <TopBar
        orgs={orgs ?? []}
        org={org}
        setOrg={setOrg}
        counts={orgCounts}
        query={query}
        setQuery={setQuery}
        filterRef={filterRef}
      />
      <Away now={now} />
      {tasks.isError ? (
        <p role="alert" className={cn("rounded-2xl p-6 text-base text-red", GLASS)}>
          Could not load tasks. {tasks.error.message}
        </p>
      ) : (
        <section aria-label="Home" className={cn("flex min-h-0 flex-1 flex-col rounded-2xl", GLASS)}>
          <Strip totals={totals} org={org} onJump={jumpTo} />
          {batch.count > 0 && (
            <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-accent-wash px-3 text-sm">
              <span className="font-medium">{batch.count} selected</span>
              {batch.label !== undefined && (
                <Button size="sm" variant="primary" onClick={() => applyToSelected(0)}>
                  <Kbd>1</Kbd>
                  {batch.label} on all
                </Button>
              )}
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="ml-auto cursor-pointer text-fg-muted hover:text-fg"
              >
                Clear (Esc)
              </button>
            </div>
          )}
          {loading ? (
            <div className="flex flex-col gap-1 p-3">
              {Array.from({ length: 6 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                <Skeleton key={i} className="h-8 w-full rounded-md" />
              ))}
            </div>
          ) : (
            <List
              entries={entries}
              quiet={quiet}
              empty={(tasks.data ?? []).length === 0}
              doneToday={totals.done}
              focusKey={focusKey}
              selected={selected}
              now={now}
              orgLabel={orgLabel}
              orgName={orgName}
              handlers={handlers}
            />
          )}
          <p className="hidden h-8 shrink-0 items-center gap-4 border-t border-line px-3 text-xs text-fg-faint min-[900px]:flex">
            <Hint keys="j k">move</Hint>
            <Hint keys="Enter">open</Hint>
            <Hint keys="1 2 3">act</Hint>
            <Hint keys="x">select</Hint>
            <Hint keys="t">triage</Hint>
            <Hint keys="/">filter</Hint>
            <Hint keys="J K">section</Hint>
          </p>
        </section>
      )}
    </div>
  );
}

function Hint({ keys, children }: { keys: string; children: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {keys.split(" ").map((k) => (
        <Kbd key={k} className="h-4 min-w-4 text-[10px]">
          {k}
        </Kbd>
      ))}
      {children}
    </span>
  );
}

/** Rows per workspace for its chip, and whether something there needs the owner. */
function useChipCounts(
  tasks: readonly { org?: string | undefined; status: string; chat?: boolean | undefined }[] | undefined,
  decisions: readonly { org?: string | undefined; task?: string | undefined }[] | undefined,
  needs: Readonly<Record<string, { needsYou: number }>> | undefined,
): ReadonlyMap<string, { rows: number; needs: boolean }> {
  return useMemo(() => {
    const by = new Map<string, { rows: number; needs: boolean }>();
    const of = (id: string) => {
      let row = by.get(id);
      if (row === undefined) {
        row = { rows: 0, needs: (needs?.[id]?.needsYou ?? 0) > 0 };
        by.set(id, row);
      }
      return row;
    };
    for (const t of tasks ?? []) if (t.status !== "done" && t.chat !== true) of(t.org ?? PRIVATE).rows += 1;
    for (const d of decisions ?? []) if (d.task === undefined && d.org !== undefined) of(d.org).rows += 1;
    for (const id of Object.keys(needs ?? {})) of(id);
    return by;
  }, [tasks, decisions, needs]);
}

function TopBar({
  orgs,
  org,
  setOrg,
  counts,
  query,
  setQuery,
  filterRef,
}: {
  orgs: readonly OrgView[];
  org: string | undefined;
  setOrg: (org: string | undefined) => void;
  counts: ReadonlyMap<string, { rows: number; needs: boolean }>;
  query: string;
  setQuery: (query: string) => void;
  filterRef: React.RefObject<HTMLInputElement | null>;
}) {
  const newTask = useNewTask();
  const { unavailable, mode, toggle, dialogs } = useAutonomousSwitch();
  const lamp = MODE_LAMP[mode];
  const chip = (pressed: boolean) =>
    cn(
      "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors max-[1279px]:px-2",
      pressed
        ? "border-accent-line bg-accent-wash text-fg"
        : "border-line-strong bg-card text-fg-muted hover:border-line-hover hover:text-fg",
    );
  return (
    <header className={cn("flex h-11 shrink-0 items-center gap-3 rounded-xl px-4", GLASS)}>
      <h1 className="text-[15px] leading-5 font-semibold tracking-[-0.01em]">Home</h1>
      <nav aria-label="Workspace" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <button
          type="button"
          aria-pressed={org === undefined}
          onClick={() => setOrg(undefined)}
          className={chip(org === undefined)}
        >
          all
        </button>
        {orgs.map((o) => {
          const c = counts.get(o.id);
          return (
            <button
              key={o.id}
              type="button"
              title={o.name}
              aria-pressed={org === o.id}
              onClick={() => setOrg(org === o.id ? undefined : o.id)}
              className={chip(org === o.id)}
            >
              <OrgBadge label={badgeLetters(o.key)} color={o.color} size="xs" />
              <span className="max-w-[110px] truncate max-[1279px]:hidden">{o.name}</span>
              <span className="tnum font-mono text-xs text-fg-muted">{c?.rows ?? 0}</span>
              {c?.needs === true && <Lamp state="needs" size={6} />}
            </button>
          );
        })}
      </nav>
      <label className="ml-auto flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md border border-line-strong bg-field px-2 text-sm text-fg-muted focus-within:border-line-hover">
        <Search aria-hidden="true" className="size-3.5 shrink-0" />
        <input
          ref={filterRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              e.currentTarget.blur();
            }
          }}
          placeholder="Filter"
          aria-label="Filter rows"
          className="w-[110px] min-w-0 bg-transparent text-fg outline-none placeholder:text-fg-faint max-[1279px]:w-[48px] max-[1279px]:focus:w-[130px]"
        />
        {query === "" ? (
          <Kbd className="h-4 min-w-4 text-[10px] max-[1279px]:hidden">/</Kbd>
        ) : (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => setQuery("")}
            className="cursor-pointer"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </label>
      <div title={unavailable} className="flex shrink-0 items-center gap-2 text-sm font-medium text-fg-soft">
        <Lamp state={lamp} size={7} />
        Auto-pilot
        {toggle}
      </div>
      <Button
        variant="ghost"
        size="sm"
        title="Search and run any command"
        onClick={() =>
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }))
        }
        className="max-[1279px]:hidden"
      >
        <Kbd>⌘K</Kbd>
      </Button>
      <Button variant="primary" size="sm" onClick={newTask.open} title="New task (n)" className="h-7">
        <Plus aria-hidden="true" strokeWidth={2.5} />
        New task
      </Button>
      {dialogs}
    </header>
  );
}

/** One line of counts: each is a jump to its section. */
function Strip({
  totals,
  org,
  onJump,
}: {
  totals: ReturnType<typeof buildHome>["totals"];
  org: string | undefined;
  onJump: (section: SectionId) => void;
}) {
  const { status } = useAutonomousSwitch();
  const segment = (section: SectionId, n: number, label: string, tone?: LampState) => {
    if (n === 0 && section !== "needs") return null;
    return (
      <button
        key={section}
        type="button"
        onClick={() => onJump(section)}
        disabled={n === 0}
        className="tnum flex shrink-0 cursor-pointer items-baseline gap-1.5 hover:text-fg disabled:cursor-default"
      >
        <b className={cn("font-mono text-md font-medium", n > 0 && tone ? LAMP_TEXT[tone] : "text-fg")}>
          {n}
        </b>
        {label}
      </button>
    );
  };
  return (
    <p className="flex h-9 shrink-0 items-baseline gap-4 overflow-hidden border-b border-line px-3 pt-2 text-sm whitespace-nowrap text-fg-muted">
      {segment("needs", totals.needs, totals.needs === 1 ? "needs you" : "need you", "needs")}
      {segment("running", totals.working, "running", "working")}
      {segment("shipping", totals.shipping, "shipping")}
      {segment("next", totals.next, "up next")}
      {segment("triage", totals.triage, "to triage")}
      {segment("captain", totals.captain, "captain handled")}
      <span className="ml-auto flex min-w-0 items-baseline gap-4">
        {status && <SpendToday status={status} className="text-sm text-fg-muted max-[1199px]:hidden" />}
        <AccountReadout org={org} />
      </span>
    </p>
  );
}

/** The list: sections as headers and one-line rows. A long one draws only what is in view. */
function List({
  entries,
  quiet,
  empty,
  doneToday,
  focusKey,
  selected,
  now,
  orgLabel,
  orgName,
  handlers,
}: {
  entries: readonly Entry[];
  quiet: boolean;
  empty: boolean;
  doneToday: number;
  focusKey: string | undefined;
  selected: ReadonlySet<string>;
  now: number;
  orgLabel: (entry: Entry) => OrgTag | undefined;
  orgName: (id: string) => string;
  handlers: RowHandlers;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const windowed = entries.length > WINDOW_FROM;
  const newTask = useNewTask();
  const virtual = useVirtualizer({
    count: windowed ? entries.length : 0,
    getScrollElement: () => scroller,
    estimateSize: (i) => (entries[i]?.type === "header" ? HEADER_ESTIMATE : ROW_ESTIMATE),
    overscan: 10,
    getItemKey: (i) => entries[i]?.key ?? i,
  });

  // The keys moved: bring the row into view.
  useEffect(() => {
    if (focusKey === undefined) return;
    if (windowed) {
      const at = entries.findIndex((e) => e.key === focusKey);
      if (at >= 0) virtual.scrollToIndex(at, { align: "auto" });
    } else {
      document.getElementById(rowDomId(focusKey))?.scrollIntoView({ block: "nearest" });
    }
  }, [focusKey, windowed, entries, virtual]);

  const draw = (entry: Entry) => (
    <EntryView
      entry={entry}
      focusKey={focusKey}
      selectedKeys={selected}
      now={now}
      orgLabel={orgLabel}
      orgName={orgName}
      handlers={handlers}
    />
  );

  return (
    <div ref={setScroller} className="scroll-fade min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {quiet && (
        <div className="flex items-center gap-3 border-b border-line px-3 py-4 text-base">
          <Lamp state="done" size={8} />
          <span className="text-fg-soft">
            {empty
              ? "No tasks yet. Create your first one."
              : `Nothing needs you and nothing is running.${doneToday > 0 ? ` ${doneToday} done today.` : ""}`}
          </span>
          <Button variant="primary" size="sm" onClick={newTask.open} className="ml-auto">
            <Plus aria-hidden="true" strokeWidth={2.5} />
            New task
          </Button>
        </div>
      )}
      {windowed ? (
        <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((row) => {
            const entry = entries[row.index];
            if (entry === undefined) return null;
            return (
              <div
                key={row.key}
                ref={virtual.measureElement}
                data-index={row.index}
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {draw(entry)}
              </div>
            );
          })}
        </div>
      ) : (
        entries.map((entry) => <Fragment key={entry.key}>{draw(entry)}</Fragment>)
      )}
    </div>
  );
}

/**
 * The account of this workspace (every account without a filter) whose 5-hour or weekly window is
 * fullest, amber from 80% and in the limit color at its limit. Its tooltip lists every window and
 * reset; it opens Health and usage.
 */
function AccountReadout({ org }: { org: string | undefined }) {
  const accounts = useAccounts().data;
  const now = useNow(60_000);
  const busiest = accounts && busiestAccount(accounts, org);
  if (!accounts || !busiest) return null;
  const text = busiestText(busiest);
  const full = busiest.limit !== undefined || busiest.pct >= USAGE_FULL_PCT;
  return (
    <PageLink
      page="usage"
      title={usageTitle(accounts, org, now)}
      className="tnum min-w-0 truncate rounded-xs text-sm text-fg-muted hover:text-fg"
    >
      <span className="font-mono text-sm text-fg">{text.head}</span>{" "}
      <b
        className={cn(
          "ml-0.5 font-mono text-md font-medium",
          full ? LAMP_TEXT.paused : busiest.pct >= USAGE_HIGH_PCT ? "text-amber" : "text-fg",
        )}
      >
        {text.value}
      </b>
      {text.rest}
    </PageLink>
  );
}

/** One slim line about the time away, until the owner closes it. */
function Away({ now }: { now: number }) {
  const summary = useUnseenSummary(now);
  if (summary === undefined) return null;
  const line = summaryLine(summary, now);
  return (
    <div className={cn("flex h-8 shrink-0 items-center gap-3 rounded-xl px-4 text-sm", GLASS)}>
      <span className="min-w-0 truncate text-fg-soft">
        <b className="font-semibold text-fg">While you were away:</b> {line.text}
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => markSeen(summary.day)}
        className="ml-auto grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint hover:bg-raised hover:text-fg"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
