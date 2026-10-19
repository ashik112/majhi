import { type QueueGroup, type TaskSummary, taskLabel } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNewTask } from "@/features/new-task/new-task-context";
import { lastAnsweredAt, useDecisionDetail } from "@/lib/decision-queries";
import { useFeedLost } from "@/lib/feed-status";
import { useNow } from "@/lib/use-now";
import { needsActions, type NeedsDeps, workActions, workWhat } from "./action-defs";
import { later as laterStore, say, undoLast } from "./actions";
import { useConsole } from "./data-context";
import { blockersOf, type ChatChip, type WorkState } from "./model";
import { buildNeeds, type Needs, type NeedsRow, splitRow } from "./needs-model";
import { initialShown, NeedsPane, needsItems, showMore } from "./needs-pane";
import { ChatPane } from "./chat-pane";
import { useConsoleActions } from "./use-actions";
import { entryKey, type RailId, selectableEntries, WorkPane, workItems } from "./work-pane";

type PaneIndex = 0 | 1 | 2;

/** The id to keep selected: the one that was, else the row now where it was, else the first. */
function keep<T extends { id: string }>(rows: readonly T[], id: string | undefined, last: number): string | undefined {
  if (id !== undefined && rows.some((r) => r.id === id)) return id;
  return rows[Math.min(Math.max(last, 0), rows.length - 1)]?.id;
}

/** Items that arrived since the first look get one short pulse. */
function useArrivals(ids: readonly string[], ready: boolean): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const key = ids.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ids`
  useEffect(() => {
    if (!ready) return;
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !seen.current?.has(id));
    for (const id of added) seen.current.add(id);
    if (added.length === 0) return;
    setFresh(new Set(added));
    const timer = window.setTimeout(() => setFresh(new Set()), 1300);
    return () => window.clearTimeout(timer);
  }, [key, ready]);
  return fresh;
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function overlayOpen(): boolean {
  return document.querySelector('dialog[open], [role="dialog"], [role="menu"], [role="listbox"][popover]') !== null;
}

/** Needs you, Work and Chat side by side. The keys are the reference's (design/console.html). */
export function ConsoleScreen() {
  const data = useConsole();
  const now = useNow(60_000);
  const lost = useFeedLost();
  const navigate = useNavigate();
  const newTask = useNewTask();
  const search = useSearch({ from: "__root__" });

  const [pane, setPane] = useState<PaneIndex>(0);
  const [needsSel, setNeedsSel] = useState<string>();
  const [workSel, setWorkSel] = useState<string>();
  const [chatPick, setChatPick] = useState<string>();
  const [chatOpen, setChatOpen] = useState(false);
  const [closed, setClosed] = useState<ReadonlySet<QueueGroup>>(new Set());
  const [shown, setShown] = useState(initialShown);
  const [closedOrgs, setClosedOrgs] = useState<ReadonlySet<string>>(new Set());
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
  const [openRails, setOpenRails] = useState<ReadonlySet<RailId>>(new Set());
  const [unmerged, setUnmerged] = useState<ReadonlySet<string>>(new Set());
  const [replying, setReplying] = useState<{ row: string; option: string }>();
  const lastNeeds = useRef(0);
  const lastWork = useRef(0);
  const chatPane = useRef<HTMLElement | null>(null);

  // Needs you, with the rows the owner took apart ("One by one") shown as separate rows.
  const needs: Needs = useMemo(() => {
    if (unmerged.size === 0) return data.needs;
    const parts = { tasks: data.tasks, orgs: data.orgs };
    const out: Needs = { ...data.needs };
    for (const group of ["incident", "decide", "review"] as const) {
      out[group] = data.needs[group].flatMap((r) => (unmerged.has(r.id) ? splitRow(r, parts) : [r]));
    }
    return out;
  }, [data.needs, data.tasks, data.orgs, unmerged]);
  const needsList = useMemo(() => needsItems(needs, shown, closed), [needs, shown, closed]);
  const needsRows = useMemo(() => needsList.flatMap((i) => (i.type === "row" ? [i.row] : [])), [needsList]);
  const needsId = keep(needsRows, needsSel, lastNeeds.current);
  lastNeeds.current = Math.max(0, needsRows.findIndex((r) => r.id === needsId));
  const needsRow = needsRows.find((r) => r.id === needsId);

  // Work
  const items = useMemo(
    () =>
      workItems({
        work: data.work,
        rails: data.rails,
        closedOrgs,
        openFolds,
        openRails,
        tasks: data.tasks,
      }),
    [data.work, data.rails, closedOrgs, openFolds, openRails, data.tasks],
  );
  const entries = useMemo(() => selectableEntries(items), [items]);
  const entryKeys = useMemo(() => entries.map((e) => ({ id: entryKey(e) })), [entries]);
  const workKey = keep(entryKeys, workSel, lastWork.current);
  lastWork.current = Math.max(0, entryKeys.findIndex((e) => e.id === workKey));
  const entry = entries.find((e) => entryKey(e) === workKey);

  const unreadById = useMemo(
    () => new Map((data.conversations ?? []).map((c) => [c.id, c.unread])),
    [data.conversations],
  );
  const stateById = useMemo(() => {
    const map = new Map<string, WorkState>();
    for (const g of data.work) for (const p of g.projects) for (const r of [...p.rows, ...p.folded]) map.set(r.task.id, r.state);
    return map;
  }, [data.work]);

  const selectedTask: TaskSummary | undefined = entry?.task;
  const chips: ChatChip[] = useMemo(() => data.chips(selectedTask), [data, selectedTask]);
  const chatId = chatPick ?? selectedTask?.id ?? "captain";

  const openChat = useCallback((id: string) => {
    setChatPick(id);
    setPane(2);
    setChatOpen(true);
  }, []);
  const acts = useConsoleActions(openChat);

  // Deep links: an old address or a link from elsewhere names a decision, a chat or a pane.
  const { id: linkId, chat: linkChat, pane: linkPane } = search;
  useEffect(() => {
    if (linkId === undefined && linkChat === undefined && linkPane === undefined) return;
    if (linkId !== undefined) {
      if (data.loading) return;
      const hit = data.needs.incident
        .concat(data.needs.decide, data.needs.review)
        .find((r) => r.decisions.some((d) => d.id === linkId));
      if (hit !== undefined) {
        setNeedsSel(hit.id);
        setPane(0);
      }
    }
    if (linkChat !== undefined) openChat(linkChat);
    if (linkPane === "needs") setPane(0);
    if (linkPane === "work") setPane(1);
    void navigate({
      to: "/",
      replace: true,
      search: (prev: Record<string, unknown>) => {
        const { id: _id, chat: _chat, pane: _pane, ...rest } = prev;
        return rest;
      },
    });
  }, [linkId, linkChat, linkPane, data.loading, data.needs, navigate, openChat]);

  const detail = useDecisionDetail(
    pane === 0 && needsRow?.decisions.length === 1 ? needsRow.decisions[0]?.id : undefined,
  ).data;

  const needsDeps: NeedsDeps = useMemo(
    () => ({
      answerOne: acts.answerOne,
      answerMany: acts.answerMany,
      unblock: (decisions, text) => acts.unblock(decisions, data.tasks, text),
      open: acts.open,
      read: acts.read,
      later: (row) => acts.putOff([row], row.name),
      unmerge: (rowId) => setUnmerged((s) => new Set([...s, rowId])),
      reply: (row, option) => setReplying({ row, option }),
    }),
    [acts, data.tasks],
  );
  const needsActionsOf = useCallback(
    (row: NeedsRow, d: typeof detail) => needsActions(row, d, needsDeps),
    [needsDeps],
  );
  const selectedNeedsActions = useMemo(
    () => (needsRow === undefined ? undefined : needsActionsOf(needsRow, detail)),
    [needsRow, detail, needsActionsOf],
  );

  const answerTask = useCallback(
    (task: TaskSummary) => {
      const row = needs.incident.concat(needs.decide, needs.review).find((r) => r.decisions.some((d) => d.task === task.id));
      if (row !== undefined) {
        setNeedsSel(row.id);
        setPane(0);
      } else openChat(task.id);
    },
    [needs, openChat],
  );
  const openTask = useCallback(
    (task: TaskSummary) => void navigate({ to: "/t/$taskId", params: { taskId: task.id }, search: {} }),
    [navigate],
  );
  const workDeps = useMemo(
    () => ({
      answer: answerTask,
      unblock: (task: TaskSummary) => acts.unblockTask(task, workWhat(task)),
      start: acts.start,
      stop: acts.stop,
      open: openTask,
    }),
    [answerTask, acts, openTask],
  );
  const workActionsOf = useMemo(() => (entry === undefined ? undefined : workActions(entry, workDeps)), [entry, workDeps]);

  const arrived = useArrivals(
    needsRows.map((r) => r.id),
    !data.loading,
  );

  const total = data.counts.needYou + needs.captain.length;
  const clear = !data.loading && total === 0;
  const visiblePanes: PaneIndex[] = clear ? [1, 2] : [0, 1, 2];

  // The keys. One listener, reading the latest state, so a keypress renders the change and nothing else.
  const live = useRef({
    pane, needsRows, needsRow, needsId, entries, entry, workKey, selectedNeedsActions, workActionsOf, needs, visiblePanes, clear,
    detail, replying, closedOrgs,
  });
  live.current = {
    pane, needsRows, needsRow, needsId, entries, entry, workKey, selectedNeedsActions, workActionsOf, needs, visiblePanes, clear,
    detail, replying, closedOrgs,
  };
  const actsRef = useRef(acts);
  actsRef.current = acts;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.defaultPrevented) return;
      const s = live.current;
      const k = event.key;
      if (typing(event.target)) {
        if (k === "Escape" && event.target instanceof HTMLElement && chatPane.current?.contains(event.target)) {
          event.target.blur();
          setChatOpen(false);
        }
        return;
      }
      if (overlayOpen()) return;
      const move = (dv: number) => {
        if (s.pane === 0) {
          const at = s.needsRows.findIndex((r) => r.id === s.needsId);
          setNeedsSel(s.needsRows[Math.max(0, Math.min(s.needsRows.length - 1, at + dv))]?.id);
          setReplying(undefined);
        } else if (s.pane === 1) {
          const at = s.entries.findIndex((e) => entryKey(e) === s.workKey);
          const next = s.entries[Math.max(0, Math.min(s.entries.length - 1, at + dv))];
          if (next !== undefined) {
            setWorkSel(entryKey(next));
            setChatPick(undefined);
          }
        }
      };
      const primary = (list: readonly { primary?: boolean; run: () => void }[] | undefined) =>
        list?.find((a) => a.primary === true)?.run();
      if (k === "j" || k === "ArrowDown") {
        if (s.pane !== 2) {
          move(1);
          event.preventDefault();
        }
      } else if (k === "k" || k === "ArrowUp") {
        if (s.pane !== 2) {
          move(-1);
          event.preventDefault();
        }
      } else if (k === "Tab") {
        const order = s.visiblePanes;
        const at = order.indexOf(s.pane);
        const next = order[(Math.max(at, 0) + (event.shiftKey ? order.length - 1 : 1)) % order.length] ?? 1;
        setPane(next);
        setChatOpen(next === 2);
        event.preventDefault();
      } else if (k === "a" && s.pane === 0) {
        primary(s.selectedNeedsActions);
      } else if (k === "a" && s.pane === 1) {
        primary(s.workActionsOf);
      } else if (k === "A" && s.pane === 0 && s.needsRow !== undefined) {
        const group = s.needsRow.group;
        const rows = s.needsRows.filter((r) => r.group === group);
        const decisions = rows.flatMap((r) => r.decisions);
        if (decisions.length > 0) {
          actsRef.current.answerMany(decisions, "approve", `Did all ${decisions.length} in this group`);
        }
      } else if ((k === "1" || k === "2" || k === "3") && s.pane === 0) {
        const picks = (s.selectedNeedsActions ?? []).filter((a) => a.ghost !== true && a.id !== "later");
        picks[Number(k) - 1]?.run();
      } else if (k === "e" && s.pane === 0 && s.needsRow !== undefined) {
        actsRef.current.putOff([s.needsRow], s.needsRow.name);
      } else if (k === "u") {
        if (!undoLast()) say("Nothing to undo.");
      } else if (k === "Enter") {
        if (s.pane === 0 && s.needsRow?.decisions[0] !== undefined) actsRef.current.open(s.needsRow.decisions[0].link);
        else if (s.pane === 0 && s.needsRow?.notice !== undefined) actsRef.current.read(s.needsRow);
        else if (s.pane === 1 && s.entry !== undefined) {
          void navigate({ to: "/t/$taskId", params: { taskId: s.entry.task.id }, search: {} });
        } else return;
      } else if (k === "s" && s.pane === 1 && s.entry !== undefined) {
        actsRef.current.stop(s.entry.task);
      } else if (k === "." && s.pane === 1 && s.entry !== undefined) {
        actsRef.current.start(s.entry.task, true);
      } else if (k === "[" && s.pane === 1 && s.entry !== undefined) {
        const org = s.entry.task.org ?? "private";
        setClosedOrgs((prev) => {
          const next = new Set(prev);
          if (next.has(org)) next.delete(org);
          else next.add(org);
          return next;
        });
      } else if (k === "c") {
        setPane(2);
        setChatOpen(true);
        window.setTimeout(() => chatPane.current?.querySelector<HTMLElement>("textarea")?.focus(), 30);
      } else if (k === "Escape") {
        if (s.replying !== undefined) setReplying(undefined);
        setChatOpen(false);
        if (s.pane === 2) setPane(s.clear ? 1 : 0);
      } else return;
      if (k !== "Tab" && k !== "j" && k !== "k" && k !== "ArrowDown" && k !== "ArrowUp") event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  // Pressed on a row: that pane has the focus, a task also opens its chat.
  const selectNeeds = useCallback((id: string) => {
    setNeedsSel(id);
    setPane(0);
    setReplying(undefined);
  }, []);
  const selectWork = useCallback((key: string) => {
    setWorkSel(key);
    setPane(1);
    setChatPick(undefined);
    setChatOpen(true);
  }, []);
  const quick = useCallback(
    (id: string) => {
      const row = needs.incident.concat(needs.decide, needs.review, needs.captain).find((r) => r.id === id);
      if (row === undefined) return;
      needsActionsOf(row, undefined).find((a) => a.primary === true)?.run();
    },
    [needs, needsActionsOf],
  );

  const waitsOnOf = useCallback(
    (task: TaskSummary) => {
      const blockers = blockersOf(task);
      const labels = blockers.slice(0, 2).map((id) => {
        const t = data.tasks.get(id);
        return t === undefined ? id : taskLabel(t);
      });
      if (labels.length === 0) return task.hold?.label;
      return `Waits on ${labels.join(", ")}${blockers.length > 2 ? ` +${blockers.length - 2}` : ""}`;
    },
    [data.tasks],
  );
  const nowLineOf = useCallback((task: TaskSummary) => task.now ?? data.doing.get(task.id)?.text, [data.doing]);

  const last = lastAnsweredAt();
  const lastText =
    last === undefined
      ? undefined
      : `Last answered at ${new Date(last).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
  const openCount = data.work.reduce((n, g) => n + g.projects.reduce((m, p) => m + p.rows.length + p.folded.length, 0), 0) + data.rails.queued.length;

  return (
    <main
      className="cs-console"
      data-testid="tasks-home"
      data-offline={lost || undefined}
      data-clear={clear || undefined}
      aria-label="Console"
      ref={(el) => {
        chatPane.current = el?.querySelector<HTMLElement>('[data-pane="chat"]') ?? null;
      }}
    >
      {clear ? (
        <section className="cs-pane" data-pane="needs" aria-label="Needs you">
          <div className="cs-vrail" aria-hidden="false">
            <ConsoleDoneLamp />
            <span className="cs-w">Needs you · all clear</span>
            <span className="cs-n">0</span>
          </div>
        </section>
      ) : (
        <NeedsPane
          needs={needs}
          shown={shown}
          closed={closed}
          selectedId={needsId}
          focus={pane === 0}
          total={data.counts.needYou}
          loading={data.loading}
          now={now}
          hues={data.hues}
          offline={lost}
          arrived={arrived}
          selectedActions={selectedNeedsActions}
          detail={detail}
          replyingId={replying?.row}
          oldestFirst
          lastAnswered={lastText}
          onSelect={selectNeeds}
          onQuick={quick}
          onToggle={(g) =>
            setClosed((prev) => {
              const next = new Set(prev);
              if (next.has(g)) next.delete(g);
              else next.add(g);
              return next;
            })
          }
          onMore={(g) => setShown((s) => showMore(s, g))}
          onReplySend={(text) => {
            const row = replying === undefined ? undefined : needsRows.find((r) => r.id === replying.row);
            const decision = row?.decisions[0];
            if (row !== undefined && decision !== undefined && replying !== undefined) {
              acts.answerOne(decision, replying.option, `${row.prefix === undefined ? "" : `${row.prefix} · `}${row.name}`, text);
            }
            setReplying(undefined);
          }}
          onReplyCancel={() => setReplying(undefined)}
          onFocus={() => setPane(0)}
        />
      )}
      <WorkPane
        items={items}
        selectedKey={workKey}
        focus={pane === 1}
        now={now}
        hues={data.hues}
        orgs={data.orgs}
        openCount={openCount}
        orgCount={data.work.length}
        unreadOf={(id) => unreadById.get(id) ?? 0}
        nowLineOf={nowLineOf}
        waitsOnOf={waitsOnOf}
        actions={workActionsOf}
        onSelect={selectWork}
        onToggleOrg={(org) =>
          setClosedOrgs((prev) => {
            const next = new Set(prev);
            if (next.has(org)) next.delete(org);
            else next.add(org);
            return next;
          })
        }
        onUnfold={(key) => setOpenFolds((s) => new Set([...s, key]))}
        onToggleRail={(id) =>
          setOpenRails((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onNewTask={newTask.open}
        onFocus={() => setPane(1)}
      />
      <ChatPane
        chips={chips}
        selected={chatId}
        tasks={data.tasks}
        stateOf={(id) => stateById.get(id)}
        hues={data.hues}
        orgs={data.orgs}
        focus={pane === 2}
        open={chatOpen}
        onPick={(id) => {
          setChatPick(id);
          setPane(2);
        }}
        onFocus={() => setPane(2)}
      />
    </main>
  );
}

function ConsoleDoneLamp() {
  return <span className="cs-lamp" data-state="done" aria-hidden="true" />;
}

export { laterStore };
