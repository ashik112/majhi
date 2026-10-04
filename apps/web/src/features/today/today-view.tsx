import type { AgendaItem, AgendaToday } from "@majhi/shared";
import { PAGE_PATH } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, CircleCheck, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Problem } from "@/components/problem";
import { useRunAttention } from "@/components/shell/banner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Lamp } from "@/components/ui/lamp";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { UsageBar } from "@/components/ui/usage-bar";
import { incidentLamp } from "@/features/watch/model";
import {
  useAgendaToday,
  useCloseDeadline,
  useDismissBrief,
  useDismissFinding,
  useMakeBrief,
  useSetReviewBudget,
} from "@/lib/agenda-queries";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useOrgFilter } from "@/lib/org-filter";
import { useWatch } from "@/lib/watch-queries";
import {
  actionOf,
  clockText,
  doneWord,
  lampOf,
  minutesText,
  REVIEW_CHOICES,
  rowLabels,
  subtitleOf,
} from "./model";

/** How many "later" rows are drawn; the rest are counted. The Decisions page holds the full queue. */
const LATER_SHOWN = 100;

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

function Panel({
  title,
  meta,
  children,
  className,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn("flex min-h-0 min-w-0 flex-col rounded-2xl p-4", GLASS, className)}
    >
      <div className="mb-2.5 flex shrink-0 items-baseline gap-3">
        <h2 className="m-0 text-body font-semibold text-fg">{title}</h2>
        {meta !== undefined && <div className="ml-auto min-w-0 text-sm text-fg-muted">{meta}</div>}
      </div>
      {children}
    </section>
  );
}

/** Holds the page's shape while the one request is out. */
function TodaySkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading today"
      className="grid min-h-0 min-w-0 flex-1 gap-3 min-[1000px]:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] min-[1000px]:grid-rows-[minmax(0,1fr)]"
    >
      <div className="flex min-h-0 flex-col gap-3">
        <div className={cn("rounded-2xl p-4", GLASS)}>
          <Skeleton className="mb-3 h-4 w-24" />
          <Skeleton className="mb-2 h-3.5 w-[86%]" />
          <Skeleton className="mb-2 h-3.5 w-[72%]" />
          <Skeleton className="h-3.5 w-[60%]" />
        </div>
        <div className={cn("flex-1 rounded-2xl p-4", GLASS)}>
          <Skeleton className="mb-4 h-4 w-32" />
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              key={i}
              className="mb-2 h-[46px] rounded-lg"
            />
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <div className={cn("h-[132px] rounded-2xl p-4", GLASS)}>
          <Skeleton className="mb-3 h-4 w-16" />
          <Skeleton className="h-3.5 w-[70%]" />
        </div>
        <div className={cn("flex-1 rounded-2xl p-4", GLASS)}>
          <Skeleton className="mb-3 h-4 w-16" />
          <Skeleton className="mb-2 h-3.5 w-[80%]" />
          <Skeleton className="h-3.5 w-[64%]" />
        </div>
      </div>
    </div>
  );
}

function BriefPanel({ today, scoped }: { today: AgendaToday; scoped: boolean }) {
  const make = useMakeBrief();
  const dismiss = useDismissBrief();
  const toast = useToast();
  const [shown, setShown] = useState(false);
  const brief = today.brief;

  if (brief?.dismissed === true && !shown) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center gap-3 rounded-2xl px-4 py-2.5 text-sm text-fg-muted",
          GLASS,
        )}
      >
        Today's brief is dismissed.
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShown(true)}>
          Show it
        </Button>
      </div>
    );
  }
  let body: ReactNode;
  if (brief !== undefined) {
    body = (
      <div className="flex flex-col gap-1">
        {brief.lines.map((line, i) => (
          <p key={line} className={cn("m-0 text-body text-pretty", i === 0 ? "text-fg" : "text-fg-soft")}>
            {line}
          </p>
        ))}
      </div>
    );
  } else if (today.briefPending) {
    body = (
      <div aria-busy="true" className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-[86%]" />
        <Skeleton className="h-3.5 w-[70%]" />
        <span className="sr-only">Writing the brief</span>
      </div>
    );
  } else {
    body = (
      <div className="flex items-center gap-3 text-body text-fg-muted">
        The brief comes at {today.briefAt}.
        <Button
          size="sm"
          disabled={make.isPending}
          onClick={() =>
            make.mutate(undefined, {
              onError: (e) => toast("Could not make the brief", { detail: describeError(e), tone: "error" }),
            })
          }
        >
          Make it now
        </Button>
      </div>
    );
  }
  return (
    <Panel
      title="Brief"
      className="shrink-0"
      meta={
        brief === undefined ? undefined : (
          <span className="flex items-center gap-2">
            <span className="tnum font-mono text-xs">
              {scoped ? "All workspaces, " : ""}
              {clockText(brief.at, today.tz)}
            </span>
            <button
              type="button"
              aria-label="Dismiss the brief"
              title="Dismiss the brief"
              onClick={() => {
                setShown(false);
                dismiss.mutate(brief.day);
              }}
              className="grid size-6 cursor-pointer place-items-center rounded-sm text-fg-faint hover:bg-raised hover:text-fg"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </span>
        )
      }
    >
      {body}
    </Panel>
  );
}

function BudgetBar({ today }: { today: AgendaToday }) {
  const set = useSetReviewBudget();
  const toast = useToast();
  const pct = (today.usedMinutes / today.budgetMinutes) * 100;
  const choices = REVIEW_CHOICES.includes(today.budgetMinutes as never)
    ? REVIEW_CHOICES
    : [...REVIEW_CHOICES, today.budgetMinutes].sort((a, b) => a - b);
  return (
    <div className="mb-2.5 flex shrink-0 flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <span className={cn("tnum font-mono text-sm", today.over ? "text-caution" : "text-fg-soft")}>
          {minutesText(today.usedMinutes)} of {minutesText(today.budgetMinutes)}
        </span>
        <UsageBar pct={pct} tone={today.over ? "amber" : "calm"} className="flex-1" />
        <label htmlFor="review-time" className="flex shrink-0 items-center gap-2 text-sm text-fg-muted">
          Review time
          <Select
            id="review-time"
            value={today.budgetMinutes}
            disabled={set.isPending}
            onChange={(e) =>
              set.mutate(Number(e.target.value), {
                onError: (err) => toast("Could not save it", { detail: describeError(err), tone: "error" }),
              })
            }
            className="h-7 w-[92px] text-sm"
          >
            {choices.map((m) => (
              <option key={m} value={m}>
                {minutesText(m)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {today.over && (
        <p className="m-0 text-sm text-caution">
          Over your review time. Incidents and dates due today stay on today's list.
        </p>
      )}
    </div>
  );
}

function Row({
  item,
  selected,
  onSelect,
  onOpen,
  onDone,
}: {
  item: AgendaItem;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onDone: () => void;
}) {
  const word = doneWord(item);
  const labels = rowLabels(item, useDecisions().data?.decisions);
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-agenda={item.id}
      onClick={onSelect}
      onKeyDown={undefined}
      className={cn(
        "group flex min-h-[46px] cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5 transition-colors duration-150",
        selected ? ROW_SELECTED : "hover:bg-raised",
      )}
    >
      <Lamp state={lampOf(item)} size={7} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-fg">{labels.title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
          <span className="shrink-0">{labels.kind}</span>
          {item.orgName !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span className="max-w-[28%] shrink-0 truncate">{item.orgName}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="truncate">{item.why}</span>
        </span>
      </div>
      <span className="tnum hidden shrink-0 font-mono text-xs text-fg-faint min-[1240px]:inline">
        {item.minutes} min
      </span>
      {selected && word !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onDone();
          }}
        >
          {word}
          <Kbd>e</Kbd>
        </Button>
      )}
      <Button
        size="sm"
        variant={selected ? "primary" : "secondary"}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        {item.action}
      </Button>
    </div>
  );
}

function AgendaPanel({
  today,
  selectedId,
  setSelectedId,
  later,
  setLater,
  onOpen,
  onDone,
}: {
  today: AgendaToday;
  selectedId: string | undefined;
  setSelectedId: (id: string) => void;
  later: boolean;
  setLater: (open: boolean) => void;
  onOpen: (item: AgendaItem) => void;
  onDone: (item: AgendaItem) => void;
}) {
  const total = today.today.length + today.later.length;
  if (total === 0) {
    return (
      <Panel title="Agenda" className="min-h-[220px] flex-1">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
          <CircleCheck aria-hidden="true" className="size-7 text-lamp-done" />
          <p className="m-0 text-lg font-semibold">Nothing needs you.</p>
          <p className="m-0 max-w-[460px] text-base text-fg-muted text-pretty">
            {today.plan.captainNext.length === 0
              ? "The captain has nothing queued."
              : `The captain works on: ${today.plan.captainNext.slice(0, 3).join("; ")}.`}
          </p>
        </div>
      </Panel>
    );
  }
  const hidden = Math.max(0, today.later.length - LATER_SHOWN);
  return (
    <Panel
      title="Agenda"
      className="min-h-[260px] flex-1"
      meta={today.later.length > 0 ? `${today.later.length} later` : undefined}
    >
      <BudgetBar today={today} />
      <div
        role="listbox"
        aria-label="Agenda"
        className="scroll-fade -mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1"
      >
        {today.today.map((item) => (
          <Row
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            onSelect={() => setSelectedId(item.id)}
            onOpen={() => onOpen(item)}
            onDone={() => onDone(item)}
          />
        ))}
        {today.later.length > 0 && (
          <button
            type="button"
            aria-expanded={later}
            onClick={() => setLater(!later)}
            className="mt-1 flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-sm text-fg-muted hover:bg-raised hover:text-fg"
          >
            {later ? (
              <ChevronDown aria-hidden="true" className="size-3.5" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-3.5" />
            )}
            Later: {today.later.length} more, about {minutesText(today.laterMinutes)}
          </button>
        )}
        {later &&
          today.later
            .slice(0, LATER_SHOWN)
            .map((item) => (
              <Row
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={() => setSelectedId(item.id)}
                onOpen={() => onOpen(item)}
                onDone={() => onDone(item)}
              />
            ))}
        {later && hidden > 0 && (
          <Link
            to={PAGE_PATH.decisions}
            className="px-3 py-2 text-sm text-fg-muted hover:text-fg hover:underline"
          >
            {hidden} more in Decisions
          </Link>
        )}
      </div>
    </Panel>
  );
}

/**
 * Right now: today's spend, the incidents the captain is on and what is running. Open incidents of watched
 * services show here too and open on the Watch page; one that is also a finding is listed once.
 */
function RightNowPanel({ today, org }: { today: AgendaToday; org: string | undefined }) {
  const { watch } = today;
  const run = useRunAttention();
  const asFinding = new Set(watch.incidents.map((i) => i.id));
  const services = (useWatch().data?.incidents ?? []).filter(
    (i) =>
      i.status === "open" &&
      (org === undefined || i.org === org) &&
      (i.finding === undefined || !asFinding.has(i.finding)),
  );
  const pct = watch.budget === undefined || watch.budget === 0 ? 0 : (watch.spent / watch.budget) * 100;
  const quiet = watch.running.length === 0 && watch.incidents.length === 0 && services.length === 0;
  return (
    <Panel
      title="Right now"
      className="shrink-0"
      meta={
        <span className="tnum font-mono text-xs">
          {formatMoney(watch.spent)}
          {watch.budget === undefined ? "" : ` of ${formatMoney(watch.budget)}`} today
          {org === undefined ? "" : ", all workspaces"}
        </span>
      }
    >
      {watch.budget !== undefined && (
        <UsageBar pct={pct} tone={pct > 100 ? "red" : "calm"} className="mb-2.5" />
      )}
      {quiet && <p className="m-0 text-sm text-fg-muted">Nothing is running and no incident is open.</p>}
      <ul className="m-0 flex max-h-[220px] list-none flex-col gap-0.5 overflow-y-auto overscroll-contain p-0">
        {services.map((i) => (
          <li key={`s${i.id}`}>
            <Link
              to={PAGE_PATH.watch}
              search={{ id: `inc-${i.id}` }}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-raised"
            >
              <Lamp state={incidentLamp(i)} size={7} />
              <span className="min-w-0 flex-1 truncate text-base text-fg">{i.title}</span>
              <span className="shrink-0 text-sm text-lamp-needs">Open in Watch</span>
            </Link>
          </li>
        ))}
        {watch.incidents.map((i) => (
          <li key={`i${i.id}`}>
            <button
              type="button"
              onClick={() =>
                run({ kind: "page", to: "/captain", search: { id: String(i.id), tab: "findings" } })
              }
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-raised"
            >
              <Lamp state="needs" size={7} />
              <span className="min-w-0 flex-1 truncate text-base text-fg">{i.title}</span>
              <span className="shrink-0 text-sm text-lamp-needs">Incident, {i.severity}</span>
            </button>
          </li>
        ))}
        {watch.running.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => run({ kind: "task", id: t.id })}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-raised"
            >
              <Lamp state="working" size={7} />
              <span className="min-w-0 flex-1 truncate text-base text-fg">{t.title}</span>
              <span className="tnum shrink-0 font-mono text-xs text-fg-faint">{t.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function PlanPanel({ today }: { today: AgendaToday }) {
  const run = useRunAttention();
  const { plan } = today;
  return (
    <Panel title="Plan" className="min-h-[200px] flex-1">
      <div className="scroll-fade -mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-1">
        <section aria-label="This week">
          <h3 className="m-0 mb-1 text-xs font-medium tracking-[0.08em] text-fg-faint uppercase">
            This week
          </h3>
          {plan.deadlines.length === 0 ? (
            <p className="m-0 text-sm text-fg-muted">No dates in the next seven days.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {plan.deadlines.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() =>
                      run({ kind: "page", to: "/deadlines", search: { id: String(d.id) } })
                    }
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-raised"
                  >
                    <Lamp state={d.daysLeft <= 0 ? "needs" : "idle"} size={7} />
                    <span className="min-w-0 flex-1 truncate text-base text-fg">{d.title}</span>
                    <span className="tnum shrink-0 text-sm text-fg-muted">{d.when}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="Goals">
          <h3 className="m-0 mb-1 text-xs font-medium tracking-[0.08em] text-fg-faint uppercase">Goals</h3>
          {plan.goals.length === 0 ? (
            <p className="m-0 text-sm text-fg-muted">
              No goals yet. Add one in{" "}
              <Link to={PAGE_PATH.playbooks} className="text-fg underline">
                Playbooks
              </Link>
              , like "99.9% uptime for Acme".
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {plan.goals.map((g) => (
                <li key={g.id} className="flex min-w-0 flex-col px-1.5">
                  <span className="truncate text-base text-fg">{g.title}</span>
                  <span className="truncate text-sm text-fg-muted">
                    {[
                      g.orgName,
                      g.target,
                      g.due === undefined ? undefined : `by ${g.due}`,
                      g.linked > 0 ? `${g.linked} linked` : undefined,
                      g.status === "proposed" ? "proposed" : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        {plan.captainNext.length > 0 && (
          <section aria-label="The captain next">
            <h3 className="m-0 mb-1 text-xs font-medium tracking-[0.08em] text-fg-faint uppercase">
              Captain next
            </h3>
            <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
              {plan.captainNext.map((t) => (
                <li key={t} className="truncate px-1.5 text-base text-fg-soft">
                  {t}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </Panel>
  );
}

/**
 * Today (`/today`): the brief, the agenda cut at the owner's review time, Watch and Plan. One request
 * fills it. Keys: j and k move, Enter takes the item's action, e dismisses a finding or closes a date.
 */
export function TodayView() {
  const { org } = useOrgFilter();
  const query = useAgendaToday(org);
  const today = query.data;
  const run = useRunAttention();
  const toast = useToast();
  const dismiss = useDismissFinding();
  const close = useCloseDeadline();
  const [picked, setPicked] = useState<string | undefined>();
  const [later, setLater] = useState(false);

  const flat = useMemo(
    () => (today === undefined ? [] : [...today.today, ...(later ? today.later.slice(0, LATER_SHOWN) : [])]),
    [today, later],
  );
  const selectedId = flat.some((i) => i.id === picked) ? picked : flat[0]?.id;

  const open = (item: AgendaItem) => run(actionOf(item.target));
  const finish = (item: AgendaItem) => {
    const done = item.done;
    if (done === undefined) return;
    const fail = (e: unknown) => toast("Could not do that", { detail: describeError(e), tone: "error" });
    if (done.kind === "dismiss-finding")
      dismiss.mutate(done.id, { onSuccess: () => toast(`Dismissed: ${item.title}`), onError: fail });
    else close.mutate(done.id, { onSuccess: () => toast(`Marked done: ${item.title}`), onError: fail });
  };

  const live = useRef({ flat, selectedId });
  live.current = { flat, selectedId };
  const act = useRef({ open, finish });
  act.current = { open, finish };
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('dialog, [role="menu"]')) return;
      if (typing(target)) return;
      const { flat: list, selectedId: id } = live.current;
      const at = list.findIndex((i) => i.id === id);
      const current = list[at];
      const move = (by: 1 | -1) => {
        const next = list[Math.min(Math.max(at + by, 0), list.length - 1)];
        if (next === undefined) return;
        setPicked(next.id);
        document
          .querySelector(`[data-agenda="${CSS.escape(next.id)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      };
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter" && current !== undefined) {
        if (target instanceof HTMLElement && target.closest("button, a")) return;
        event.preventDefault();
        act.current.open(current);
      } else if (event.key === "e" && current?.done !== undefined) {
        event.preventDefault();
        act.current.finish(current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  let body: ReactNode;
  if (query.isError && today === undefined) {
    body = <Problem icon={<CircleCheck />} title="Could not load Today" body={describeError(query.error)} />;
  } else if (today === undefined) {
    body = <TodaySkeleton />;
  } else {
    body = (
      <div className="grid min-h-0 min-w-0 flex-1 gap-3 max-[999px]:overflow-y-auto min-[1000px]:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] min-[1000px]:grid-rows-[minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <BriefPanel today={today} scoped={org !== undefined} />
          <AgendaPanel
            today={today}
            selectedId={selectedId}
            setSelectedId={setPicked}
            later={later}
            setLater={setLater}
            onOpen={open}
            onDone={finish}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <RightNowPanel today={today} org={org} />
          <PlanPanel today={today} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Today"
        subtitle={
          today === undefined
            ? "The brief, the agenda and what is coming."
            : subtitleOf({
                day: today.day,
                count: today.today.length,
                minutes: today.usedMinutes,
                later: today.later.length,
              })
        }
      />
      {body}
    </div>
  );
}
