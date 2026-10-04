import { useNavigate, useSearch } from "@tanstack/react-router";
import { CircleCheck, Inbox } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Problem } from "@/components/problem";
import { useRunAttention } from "@/components/shell/banner";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Kbd } from "@/components/ui/kbd";
import { ListDetail, ListPane } from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { lastAnsweredAt, useAnswerDecision, useDecisionDetail, useDecisions } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import type { AppSearch } from "@/router";
import { DecisionDetailPane } from "./decision-detail";
import { DecisionList } from "./decision-list";
import { useNeedsYou } from "./needs-you";
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

  const send = (option: string, text?: string) => {
    if (selected === undefined || answer.isPending) return;
    const queue = shown.map((d) => d.id);
    const done = selected;
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

  const openSelected = () => {
    if (selected !== undefined) run(actionOf(selected.link));
  };

  // Keys. They read the latest state through a ref, so the listener is bound once.
  const blocked = detail.data?.blocked;
  const live = useRef({ shown, selected, selectedId, replyOpen, narrow, blocked });
  live.current = { shown, selected, selectedId, replyOpen, narrow, blocked };
  const act = useRef({ send, openSelected, select });
  act.current = { send, openSelected, select };
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
  const subtitle =
    all === undefined
      ? "What waits for you, with a recommendation where the captain has one."
      : all.length === 0
        ? "All answered."
        : `${total} waiting for you`;
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
      <ListPane label="Decisions" className="w-[340px] min-[1320px]:w-[380px] max-[999px]:w-full">
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
          <DecisionList decisions={shown} selected={selectedId} now={now} onSelect={(id) => select(id)} />
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
            {orgs.length > 1 && (
              <>
                <ChoiceChip className={CHIP} pressed={org === undefined} onClick={() => setOrg(undefined)}>
                  All workspaces
                  <span className="tnum font-mono text-fg-faint">
                    {[...byOrg.values()].reduce((n, c) => n + c, 0)}
                  </span>
                </ChoiceChip>
                {orgs
                  .filter((o) => (byOrg.get(o.id) ?? 0) > 0 || o.id === org)
                  .map((o) => (
                    <ChoiceChip
                      key={o.id}
                      className={`${CHIP} max-w-[170px]`}
                      pressed={org === o.id}
                      onClick={() => setOrg(o.id)}
                    >
                      <span className="min-w-0 truncate">{o.name}</span>
                      <span className="tnum font-mono text-fg-faint">{byOrg.get(o.id) ?? 0}</span>
                    </ChoiceChip>
                  ))}
                <span aria-hidden="true" className="mx-1 h-4 w-px bg-line-strong" />
              </>
            )}
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
          </fieldset>
        )}
        <ListDetail>
          {narrow ? (pane ?? list) : list}
          {!narrow && pane}
        </ListDetail>
        {!narrow && (
          <p className="m-0 mt-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-faint">
            <span>
              <Kbd>j</Kbd> <Kbd>k</Kbd> move
            </span>
            <span>
              <Kbd>Enter</Kbd> main action
            </span>
            <span>
              <Kbd>1</Kbd> to <Kbd>3</Kbd> pick an answer
            </span>
            <span>
              <Kbd>r</Kbd> reply
            </span>
            <span>
              <Kbd>o</Kbd> open the task
            </span>
            <span>
              <Kbd>Esc</Kbd> close the reply
            </span>
          </p>
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Decisions" subtitle={subtitle} />
      {body}
    </div>
  );
}
