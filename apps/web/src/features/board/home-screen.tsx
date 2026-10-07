import { type OrgView, PRIVATE, type TaskSummary } from "@majhi/shared";
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
import { accountReadout, busiestAccount, USAGE_FULL_PCT, usageTitle } from "@/features/accounts/model";
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
import { useAreas, useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { useNewTask } from "../new-task/new-task-context";
import { CHORD_MS } from "../shell/shortcuts";
import { areaNames } from "../tasks-ui/area-chips";
import type { OrgTag } from "../tasks-ui/project-names";
import { BoardColumns } from "./board-columns";
import { type EntryContext, type RowHandlers, rowDomId } from "./entry-context";
import { liveStates } from "./entry-text";
import { type Chips, chipsActive, FilterBar, NO_CHIPS, type Toggle } from "./filter-bar";
import { useHomeActions } from "./home-actions";
import {
  actionsOf,
  allTaskRows,
  buildEntries,
  buildHome,
  buildTree,
  type Entry,
  focusable,
  jumpSection,
  type RowEntry,
  relationsOf,
  SECTION_LABEL,
  type SectionId,
  stepFocus,
  type TreeInfo,
} from "./home-model";
import { compareTaskIds, partOf } from "./model";
import { EntryRow } from "./tree-rows";

type HomeView = "board" | "tree";
const VIEW_KEY = "majhi.home.view";

function readView(): HomeView {
  try {
    return localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "board";
  } catch {
    return "board";
  }
}

function writeView(view: HomeView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Storage can be blocked; the view then lasts until the page reloads.
  }
}

/** A tree longer than this draws only the rows in view (and a few around them). */
const WINDOW_FROM = 60;
const ROW_ESTIMATE = 37;
/** How often the clock of the rows moves: the elapsed time of a running check reads in seconds. */
const NOW_TICK_MS = 15_000;
/** The sections the owner turns on from the filter bar. */
const TOGGLED: readonly SectionId[] = ["triage", "done", "captain"];

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

const isRow = (entry: Entry | undefined): entry is RowEntry =>
  entry !== undefined && entry.type !== "header" && entry.type !== "more";

/** The subtasks of each parent task, in id order. */
function kidsByParent(tasks: readonly TaskSummary[]): Map<string, TaskSummary[]> {
  const by = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    const parent = partOf(task);
    if (parent === undefined || parent === task.id) continue;
    by.set(parent, [...(by.get(parent) ?? []), task]);
  }
  for (const list of by.values()) list.sort((a, b) => compareTaskIds(a.id, b.id));
  return by;
}

/** Tasks: what needs the owner, what runs, what waits, what ships and what is next, as a board or a tree. */
export function BoardScreen() {
  const tasks = useTasks();
  const decisions = useDecisions();
  const orgs = useOrgs().data;
  const { org, setOrg } = useOrgFilter();
  const now = useNow(NOW_TICK_MS);
  const log = useCaptainLog(org);
  const blockers = useBlockers();
  const facts = useHomeFacts();
  const { act, open, openTask } = useHomeActions();
  const client = useQueryClient();

  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<Chips>(NO_CHIPS);
  const [opened, setOpened] = useState<ReadonlySet<SectionId>>(new Set());
  const [all, setAll] = useState<ReadonlySet<SectionId>>(new Set());
  const [focusKey, setFocusKey] = useState<string | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [view, setViewState] = useState<HomeView>(readView);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
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

  const taskList = tasks.data;
  const taskById = useMemo(() => new Map((taskList ?? []).map((t) => [t.id, t])), [taskList]);
  const kids = useMemo(() => kidsByParent(taskList ?? []), [taskList]);

  // The parts of the system are read from each task's worktree: only the open tasks the board draws.
  const areaIds = useMemo(
    () => (taskList ?? []).filter((t) => t.status !== "done" && t.repos.length > 0).map((t) => t.id),
    [taskList],
  );
  const areaData = useAreas(areaIds);
  const areas = useMemo(() => new Map([...areaData].map(([id, a]) => [id, areaNames(a)])), [areaData]);
  const areaOptions = useMemo(() => [...new Set([...areas.values()].flat())].toSorted(), [areas]);

  const homeInput = useMemo(
    () => ({
      tasks: taskList ?? [],
      decisions: decisions.data?.decisions ?? [],
      working,
      blockers,
      mrs: facts.mrs,
      mrExtra: facts.mrExtra,
      doing: facts.doing,
      checks: facts.checks,
      background: facts.background,
      deploys: facts.deploys,
      captain: captainActions ?? [],
      undoOf,
      areas,
      now,
    }),
    [taskList, decisions.data, working, blockers, facts, captainActions, undoOf, areas, now],
  );
  const filters = useMemo(() => ({ org, query, ...chips }), [org, query, chips]);
  // The strip counts what the board draws: a subtask nested in its parent's card is not one more.
  const board = useMemo(
    () => buildHome({ ...homeInput, ...filters, nest: { opened } }),
    [homeInput, filters, opened],
  );
  const { sections, totals } = board;
  const tree = view === "tree";
  // The tree keeps a parent that fails the filters, for context: it needs every row, filtered or not.
  const treeSections = useMemo(
    () => (tree ? buildHome({ ...homeInput, ...filters }).sections : undefined),
    [tree, homeInput, filters],
  );
  const everything = useMemo(
    () => buildHome({ ...homeInput, org: undefined, query: "" }).sections,
    [homeInput],
  );
  const treeRows = useMemo(
    () =>
      treeSections === undefined ? undefined : buildTree(everything, treeSections, taskById, folded, opened),
    [treeSections, everything, taskById, folded, opened],
  );
  const entries: readonly Entry[] = useMemo(
    () => treeRows?.entries ?? buildEntries(sections, { opened, all }),
    [treeRows, sections, opened, all],
  );
  const treeInfo: ReadonlyMap<string, TreeInfo> | undefined = treeRows?.info;
  const relations = useMemo(() => relationsOf(entries, taskById), [entries, taskById]);
  const setView = useCallback((next: HomeView) => {
    setViewState(next);
    writeView(next);
  }, []);
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
        case "held":
        case "running":
        case "background":
        case "waiting":
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
  const foldTask = useCallback((task: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(task)) next.add(task);
      return next;
    });
  }, []);

  const live = useRef({ entries, entryByKey, focusKeys, focusKey, selected, relations, treeInfo });
  live.current = { entries, entryByKey, focusKeys, focusKey, selected, relations, treeInfo };

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
      onOpenTask: openTask,
      onMore: moreOf,
      onFold: foldTask,
    }),
    [runAction, openRow, openTask, moreOf, foldTask],
  );

  const lineCtx = useMemo(() => ({ now, orgName, kids, tasks: taskById }), [now, orgName, kids, taskById]);
  const liveOf = useMemo(() => liveStates(allTaskRows(everything), lineCtx), [everything, lineCtx]);
  const ctx: EntryContext = useMemo(
    () => ({
      now,
      line: lineCtx,
      live: liveOf,
      relations,
      tasks: taskById,
      areas,
      orgLabel,
      treeInfo,
      handlers,
    }),
    [now, lineCtx, liveOf, relations, taskById, areas, orgLabel, treeInfo, handlers],
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
      } else if (key === "Escape") {
        if (state.selected.size > 0) setSelected(new Set());
      } else if (current !== undefined) {
        if (key === "Enter") {
          if (target instanceof HTMLElement && target.closest("button, a, input")) return;
          event.preventDefault();
          if (current.type === "more") moreOf(current.section);
          else if (isRow(current)) openRow(current.key);
        } else if ((key === "ArrowLeft" || key === "ArrowRight") && state.treeInfo !== undefined) {
          // In the tree, left folds the subtasks of the row and right unfolds them.
          const where = state.treeInfo.get(current.key);
          const task = state.relations.get(current.key)?.task;
          if (where?.hasChildren && task !== undefined && where.open === (key === "ArrowLeft")) {
            event.preventDefault();
            foldTask(task);
          }
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
  }, [runAction, openRow, moreOf, foldTask, applyToSelected]);

  // The first row of a section: the strip sends the keys there.
  const jumpTo = useCallback((section: SectionId) => {
    const first = live.current.entries.find((e) => e.section === section && focusable(e));
    if (first !== undefined) setFocusKey(first.key);
  }, []);

  const loading = tasks.isPending || decisions.isPending;
  const filtered = chipsActive(chips) || query !== "";
  const nothing = totals.needs + totals.running + totals.waiting + totals.shipping + totals.next === 0;
  const quiet = nothing && !filtered;
  const noMatch = nothing && filtered && totals.triage + totals.done + totals.captain === 0;
  const orgCounts = useChipCounts(tasks.data, decisions.data?.decisions, decisions.data?.counts.orgs);
  const toggles: Toggle[] = TOGGLED.filter((s) => s !== "captain" || totals.captain > 0 || opened.has(s)).map(
    (section) => ({
      section,
      label: section === "captain" ? "Captain" : SECTION_LABEL[section],
      count: totals[section],
      on: opened.has(section),
    }),
  );

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
        view={view}
        setView={setView}
      />
      <Away now={now} />
      {tasks.isError ? (
        <p role="alert" className={cn("rounded-2xl p-6 text-base text-red", GLASS)}>
          Could not load tasks. {tasks.error.message}
        </p>
      ) : (
        <section aria-label="Tasks" data-testid="tasks-home" className="flex min-h-0 flex-1 flex-col">
          <div className={cn("shrink-0 overflow-hidden rounded-2xl", GLASS)}>
            <Strip totals={totals} org={org} onJump={jumpTo} />
            <FilterBar
              chips={chips}
              onChips={setChips}
              areaNames={areaOptions}
              toggles={toggles}
              onToggle={toggleSection}
            />
          </div>
          {batch.count > 0 && (
            <div className="mt-2 flex h-9 shrink-0 items-center gap-3 rounded-xl border border-line bg-accent-wash px-3 text-sm">
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
          ) : tree ? (
            <TreeList
              entries={entries}
              quiet={quiet}
              noMatch={noMatch}
              empty={(tasks.data ?? []).length === 0}
              doneToday={totals.done}
              focusKey={focusKey}
              selected={selected}
              ctx={ctx}
              onClear={() => {
                setChips(NO_CHIPS);
                setQuery("");
              }}
            />
          ) : (
            <BoardView
              entries={entries}
              quiet={quiet}
              noMatch={noMatch}
              empty={(tasks.data ?? []).length === 0}
              doneToday={totals.done}
              focusKey={focusKey}
              selected={selected}
              ctx={ctx}
              onClear={() => {
                setChips(NO_CHIPS);
                setQuery("");
              }}
            />
          )}
          <p
            className={cn(
              "mt-2 hidden h-8 shrink-0 items-center gap-4 rounded-xl px-3 text-xs text-fg-faint min-[900px]:flex",
              GLASS,
            )}
          >
            <Hint keys="j k">move</Hint>
            <Hint keys="Enter">open</Hint>
            <Hint keys="1 2 3">act</Hint>
            <Hint keys="x">select</Hint>
            <Hint keys="t">ideas</Hint>
            <Hint keys="/">filter</Hint>
            {!tree && <Hint keys="J K">column</Hint>}
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
  view,
  setView,
}: {
  orgs: readonly OrgView[];
  org: string | undefined;
  setOrg: (org: string | undefined) => void;
  counts: ReadonlyMap<string, { rows: number; needs: boolean }>;
  query: string;
  setQuery: (query: string) => void;
  filterRef: React.RefObject<HTMLInputElement | null>;
  view: HomeView;
  setView: (view: HomeView) => void;
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
      <h1 className="text-[15px] leading-5 font-semibold tracking-[-0.01em]">Tasks</h1>
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
      <fieldset aria-label="View" className="m-0 flex min-w-0 shrink-0 items-center gap-1 border-0 p-0">
        {(["board", "tree"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            title={v === "board" ? "Columns by who holds the ball" : "Subtasks under their parent task"}
            onClick={(event) => {
              setView(v);
              // The row keys (Enter, 1 to 3) skip a focused button: hand them back to the list.
              event.currentTarget.blur();
            }}
            className={chip(view === v)}
          >
            {v === "board" ? "Board" : "Tree"}
          </button>
        ))}
      </fieldset>
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

/** What each count means, on hover. */
const STRIP_HINT: Partial<Record<SectionId, string>> = {
  needs: "Questions, approvals, finished work and holds that wait for you.",
  running: "Agents working now, plus checks, processes and previews that run in the background.",
  waiting: "Tasks held by something that lifts itself: a limit, a budget, another task or their subtasks.",
  shipping: "Tasks with an open merge request, waiting on CI or on a merge.",
  next: "Tasks that can start, waiting for a slot, an account or the captain.",
};

/** One line of counts: each is a jump to its column. */
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
  const segment = (section: SectionId, n: number, label: string, tone?: LampState) => (
    <button
      key={section}
      type="button"
      title={STRIP_HINT[section]}
      onClick={() => onJump(section)}
      disabled={n === 0}
      className="tnum flex shrink-0 cursor-pointer items-baseline gap-1.5 hover:text-fg disabled:cursor-default"
    >
      <b className={cn("font-mono text-md font-medium", n > 0 && tone ? LAMP_TEXT[tone] : "text-fg")}>{n}</b>
      {label}
    </button>
  );
  return (
    <p className="flex h-9 shrink-0 items-baseline gap-4 overflow-hidden border-b border-line px-3 pt-2 text-sm whitespace-nowrap text-fg-muted">
      {segment("needs", totals.needs, totals.needs === 1 ? "needs you" : "need you", "needs")}
      {segment("running", totals.working, "running", "working")}
      {segment("waiting", totals.waiting, "waiting")}
      {segment("shipping", totals.shipping, "shipping")}
      {segment("next", totals.next, "up next")}
      <span className="ml-auto flex min-w-0 items-baseline gap-4">
        {status && <SpendToday status={status} className="text-sm text-fg-muted max-[1199px]:hidden" />}
        <AccountReadout org={org} />
      </span>
    </p>
  );
}

/** What the board says when it has nothing to draw: no tasks yet, nothing to do, or nothing that matches. */
function Notice({
  quiet,
  noMatch,
  empty,
  doneToday,
  onClear,
}: {
  quiet: boolean;
  noMatch: boolean;
  empty: boolean;
  doneToday: number;
  onClear: () => void;
}) {
  const newTask = useNewTask();
  if (noMatch)
    return (
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="pointer-events-auto flex flex-col items-center gap-2.5 text-center">
          <h2 className="text-md font-semibold">No tasks match</h2>
          <Button variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        </div>
      </div>
    );
  if (!quiet) return null;
  return (
    <div className={cn("mt-3 flex shrink-0 items-center gap-3 rounded-2xl px-3 py-4 text-base", GLASS)}>
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
  );
}

interface ViewProps {
  entries: readonly Entry[];
  quiet: boolean;
  noMatch: boolean;
  empty: boolean;
  doneToday: number;
  focusKey: string | undefined;
  selected: ReadonlySet<string>;
  ctx: EntryContext;
  onClear: () => void;
}

/** The board: columns of cards. The key that moved brings its card into view, inside its column and across the board. */
function BoardView({
  entries,
  quiet,
  noMatch,
  empty,
  doneToday,
  focusKey,
  selected,
  ctx,
  onClear,
}: ViewProps) {
  useEffect(() => {
    if (focusKey === undefined) return;
    document.getElementById(rowDomId(focusKey))?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusKey]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Notice quiet={quiet} noMatch={noMatch} empty={empty} doneToday={doneToday} onClear={onClear} />
      <BoardColumns entries={entries} focusKey={focusKey} selected={selected} ctx={ctx} />
    </div>
  );
}

/** The tree: one-line rows, subtasks nested under their parent. A long one draws only what is in view. */
function TreeList({
  entries,
  quiet,
  noMatch,
  empty,
  doneToday,
  focusKey,
  selected,
  ctx,
  onClear,
}: ViewProps) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const windowed = entries.length > WINDOW_FROM;
  const virtual = useVirtualizer({
    count: windowed ? entries.length : 0,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_ESTIMATE,
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

  const draw = (entry: Entry) =>
    isRow(entry) ? <EntryRow entry={entry} focusKey={focusKey} selectedKeys={selected} ctx={ctx} /> : null;

  return (
    <div className={cn("relative mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl", GLASS)}>
      <Notice quiet={quiet} noMatch={noMatch} empty={empty} doneToday={doneToday} onClear={onClear} />
      <div ref={setScroller} className="scroll-fade min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
  const text = accountReadout(busiest || undefined);
  if (!accounts || !busiest || !text) return null;
  const full = busiest.limit !== undefined || busiest.pct >= USAGE_FULL_PCT;
  return (
    <PageLink
      page="usage"
      data-testid="account-readout"
      title={usageTitle(accounts, org, now)}
      className="tnum min-w-0 truncate rounded-xs text-sm text-fg-muted hover:text-fg"
    >
      <span className="font-mono text-sm text-fg">{text.head}</span>{" "}
      <b className={cn("ml-0.5 font-mono text-md font-medium", full ? LAMP_TEXT.paused : "text-amber")}>
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
