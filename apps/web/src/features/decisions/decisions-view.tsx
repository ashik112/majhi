import { batchPlan, likeThis, type OwnerDecision } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CircleCheck, GitMerge, Inbox } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Problem } from "@/components/problem";
import { useRunAttention } from "@/components/shell/banner";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Kbd } from "@/components/ui/kbd";
import { ListDetail, ListPane } from "@/components/ui/list-detail";
import { Select } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { lastAnsweredAt, useAnswerDecision, useDecisionDetail, useDecisions } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import type { AppSearch } from "@/router";
import { BatchBar } from "./batch-bar";
import { DecisionDetailPane } from "./decision-detail";
import { DecisionList } from "./decision-list";
import {
  actionOf,
  afterAnswer,
  applyFilters,
  KIND_FILTERS,
  type KindFilter,
  kindCounts,
  lastAnswerText,
  primaryOption,
  rowTitle,
  workspaceCounts,
} from "./model";
import { useNeedsYou } from "./needs-you";
import { useBatch } from "./use-batch";

function ageWord(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

const CHIP = "min-h-7 px-2.5 text-xs";

/**
 * The Decisions page (`/decisions`, SPEC 5.18): a queue on the left and the selected decision in full
 * on the right, so a decision is made here without opening its task. Answering selects the next one.
 * Below 1000px the pane is the page and the queue is its back view.
 */
export function DecisionsView() {
  const query = useDecisions();
  const orgs = useOrgs().data ?? [];
  const { org, setOrg } = useOrgFilter();
  const [kind, setKind] = useState<KindFilter | undefined>();
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const run = useRunAttention();
  const toast = useToast();
  const answer = useAnswerDecision();
  const now = useNow(60_000);
  const narrow = useMedia("(max-width: 999px)");
  const all = query.data?.decisions;

  const shown = useMemo(() => applyFilters(all ?? [], { org, kind }), [all, org, kind]);
  const wanted = search.id;
  const selectedId = shown.some((d) => d.id === wanted) ? wanted : narrow ? undefined : shown[0]?.id;
  const selected = shown.find((d) => d.id === selectedId);

  // A link from the bell or the Captain page can name a decision a filter hides: show all then.
  useEffect(() => {
    if (wanted === undefined || all === undefined) return;
    if (all.some((d) => d.id === wanted) && !shown.some((d) => d.id === wanted)) {
      setOrg(undefined);
      setKind(undefined);
    }
  }, [wanted, all, shown, setOrg]);

  const select = (id: string | undefined) =>
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => {
        const { id: _drop, ...rest } = prev;
        return id === undefined ? rest : { ...rest, id };
      },
      replace: true,
    });

  const batch = useBatch(shown);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const pickedList = useMemo(() => shown.filter((d) => batch.picked.has(d.id)), [shown, batch.picked]);
  const like = useMemo(() => (selected === undefined ? [] : likeThis(shown, selected)), [shown, selected]);

  const detail = useDecisionDetail(selectedId);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [working, setWorking] = useState<string | undefined>();
  // A new selection starts with a closed, empty reply box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per selection
  useEffect(() => {
    setReplyOpen(false);
    setReplyText("");
  }, [selectedId]);

  const sendFor = (done: OwnerDecision, option: string, text?: string) => {
    if (answer.isPending) return;
    const queue = shown.map((d) => d.id);
    const label = done.options.find((o) => o.id === option)?.label ?? option;
    setWorking(option);
    answer.mutate(
      { id: done.id, option, ...(text === undefined ? {} : { text }) },
      {
        onSuccess: (left) => {
          toast(`${label}: ${rowTitle(done)}`);
          const keep = new Set(applyFilters(left.decisions, { org, kind }).map((d) => d.id));
          select(afterAnswer(queue, done.id, [...keep]));
        },
        onError: (error) => toast("Could not answer it", { detail: describeError(error), tone: "error" }),
        onSettled: () => setWorking(undefined),
      },
    );
  };

  const send = (option: string, text?: string) => {
    if (selected !== undefined) sendFor(selected, option, text);
  };

  const openSelected = () => {
    if (selected !== undefined) run(actionOf(selected.link));
  };

  // Keys. They read the latest state through a ref, so the listener is bound once.
  const blocked = detail.data?.blocked;
  const live = useRef({ shown, selected, selectedId, replyOpen, narrow, blocked });
  live.current = { shown, selected, selectedId, replyOpen, narrow, blocked };
  const act = useRef({ send, openSelected, select, toggle: batch.toggle });
  act.current = { send, openSelected, select, toggle: batch.toggle };
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const state = live.current;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('dialog, [role="menu"], [role="listbox"]')) return;
      if (typing(target)) return;
      const { shown: list, selected: current, selectedId: id } = state;
      const step = (by: 1 | -1) => {
        if (list.length === 0) return;
        const at = id === undefined ? -1 : list.findIndex((d) => d.id === id);
        const next = list[Math.min(Math.max(at + by, 0), list.length - 1)];
        if (next !== undefined) act.current.select(next.id);
      };
      const key = event.key;
      if (key === "j" || key === "ArrowDown") {
        event.preventDefault();
        step(1);
      } else if (key === "k" || key === "ArrowUp") {
        event.preventDefault();
        step(-1);
      } else if (key === "Escape") {
        if (state.narrow && id !== undefined) act.current.select(undefined);
      } else if (current !== undefined) {
        const text = current.options.find((o) => o.text === true);
        if (key === "Enter") {
          if (target instanceof HTMLElement && target.closest("button, a")) return;
          event.preventDefault();
          const primary = primaryOption(current, state.blocked);
          if (primary === undefined) act.current.openSelected();
          else if (primary.text === true) setReplyOpen(true);
          else act.current.send(primary.id);
        } else if (/^[1-9]$/.test(key)) {
          const option = current.options[Number(key) - 1];
          if (option === undefined || state.blocked?.[option.id] !== undefined) return;
          event.preventDefault();
          if (option.text === true) setReplyOpen(true);
          else act.current.send(option.id);
        } else if (key === "r" && text !== undefined) {
          event.preventDefault();
          setReplyOpen(true);
        } else if (key === "x" || key === "X") {
          event.preventDefault();
          act.current.toggle(current.id, event.shiftKey);
        } else if (key === "o") {
          event.preventDefault();
          act.current.openSelected();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const total = useNeedsYou();
  const byOrg = useMemo(() => workspaceCounts(all ?? [], kind), [all, kind]);
  const byKind = useMemo(() => kindCounts(all ?? [], org), [all, org]);
  const oldest =
    all === undefined || all.length === 0 ? undefined : Math.min(...all.map((d) => Date.parse(d.at)));
  const subtitle =
    all === undefined
      ? undefined
      : all.length === 0
        ? "All answered"
        : `${total} ${total === 1 ? "decision" : "decisions"}${oldest === undefined ? "" : `, oldest ${ageWord(now - oldest)}`}`;
  const ready = shown.filter((d) => d.kind === "ship" && batchPlan([d], "approve").ids.length > 0);
  const answered = lastAnswerText(lastAnsweredAt(), (iso) => formatAgo(iso, now));

  let body: React.ReactNode;
  if (query.isError) {
    body = (
      <Problem icon={<Inbox />} title="Could not load the decisions" body={describeError(query.error)} />
    );
  } else if (all === undefined) {
    body = <RowsSkeleton rows={4} height={64} />;
  } else if (all.length === 0) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
        <CircleCheck aria-hidden="true" className="size-7 text-lamp-done" />
        <p className="m-0 text-lg font-semibold">Nothing needs you.</p>
        <p className="m-0 text-base text-fg-muted">
          {answered ?? "Questions, approvals and work ready to ship show up here."}
        </p>
      </div>
    );
  } else {
    const list = (
      <ListPane
        label="Decisions"
        scrollRef={setScroller}
        className="w-0 flex-[1.15] max-[999px]:w-full min-[1320px]:w-0"
        footer={
          shown.length === 0 ? undefined : (
            <BatchBar
              picked={pickedList}
              selected={selected}
              like={like}
              hold={batch.hold}
              sending={batch.sending}
              result={batch.result}
              failure={batch.failure}
              total={shown.length}
              onStart={batch.start}
              onUndo={batch.undo}
              onNow={batch.now}
              onClear={batch.clear}
              onSelectAll={batch.selectAll}
              onDismiss={batch.dismiss}
            />
          )
        }
      >
        {shown.length === 0 ? (
          <div className="flex flex-col items-start gap-2 p-3 text-sm text-fg-muted">
            Nothing matches these filters.
            <Button
              size="sm"
              onClick={() => {
                setOrg(undefined);
                setKind(undefined);
              }}
            >
              Show everything
            </Button>
          </div>
        ) : (
          <DecisionList
            decisions={shown}
            selected={selectedId}
            now={now}
            scroller={scroller}
            picked={batch.picked}
            held={batch.held}
            onSelect={(id) => select(id)}
            busy={answer.isPending}
            working={working}
            onPick={batch.toggle}
            onAnswer={sendFor}
          />
        )}
      </ListPane>
    );
    const pane =
      selected === undefined ? null : (
        <DecisionDetailPane
          key={selected.id}
          decision={selected}
          detail={detail.data}
          detailError={detail.isError ? describeError(detail.error) : undefined}
          now={now}
          busy={answer.isPending}
          working={working}
          replyOpen={replyOpen}
          replyText={replyText}
          onReplyText={setReplyText}
          onReplyOpen={setReplyOpen}
          onAnswer={send}
          onOpen={openSelected}
          onBack={narrow ? () => select(undefined) : undefined}
        />
      );
    body = (
      <>
        {(!narrow || selected === undefined) && (
          <fieldset
            aria-label="Filters"
            className="m-0 mb-3 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
          >
            <ChoiceChip className={CHIP} pressed={kind === undefined} onClick={() => setKind(undefined)}>
              All
              <span className="tnum font-mono text-fg-faint">
                {[...byKind.values()].reduce((n, c) => n + c, 0)}
              </span>
            </ChoiceChip>
            {KIND_FILTERS.filter((k) => (byKind.get(k.id) ?? 0) > 0 || k.id === kind).map((k) => (
              <ChoiceChip
                key={k.id}
                className={CHIP}
                pressed={kind === k.id}
                onClick={() => setKind(kind === k.id ? undefined : k.id)}
              >
                {k.label}
                <span className="tnum font-mono text-fg-faint">{byKind.get(k.id) ?? 0}</span>
              </ChoiceChip>
            ))}
            {orgs.length > 1 && (
              <Select
                aria-label="Workspace"
                value={org ?? ""}
                onChange={(e) => setOrg(e.target.value === "" ? undefined : e.target.value)}
                className="ml-auto h-7 w-auto min-w-0 max-w-[180px] py-0 text-xs"
              >
                <option value="">All workspaces</option>
                {orgs
                  .filter((o) => (byOrg.get(o.id) ?? 0) > 0 || o.id === org)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
              </Select>
            )}
          </fieldset>
        )}
        <ListDetail>
          {narrow ? (pane ?? list) : list}
          {!narrow && pane}
        </ListDetail>
        {!narrow && (
          <p className="m-0 mt-2 flex shrink-0 items-center gap-1.5 truncate text-xs text-fg-faint">
            <Kbd>x</Kbd> pick <Kbd>j</Kbd> <Kbd>k</Kbd> move <Kbd>1</Kbd>-<Kbd>3</Kbd> answer <Kbd>r</Kbd>{" "}
            reply <Kbd>o</Kbd> open
          </p>
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={`mb-3 flex min-h-[44px] shrink-0 items-center gap-4 rounded-2xl px-4 py-2 ${GLASS}`}>
        <h1 className="text-md leading-5 font-semibold text-fg">Needs you</h1>
        {subtitle !== undefined && <span className="text-sm text-fg-muted">{subtitle}</span>}
        {ready.length > 0 && (
          <Button
            size="sm"
            className="ml-auto"
            disabled={batch.hold !== undefined}
            onClick={() =>
              batch.start(
                "approve",
                ready.map((d) => d.id),
              )
            }
          >
            <GitMerge aria-hidden="true" />
            Merge all ready ({ready.length})
          </Button>
        )}
      </header>
      {body}
    </div>
  );
}
