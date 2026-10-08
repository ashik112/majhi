import { type CaptainOrg, didWords, type Finding, opportunityEffort } from "@majhi/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Lamp } from "@/components/ui/lamp";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { TaskRef } from "@/features/autonomy/task-ref";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import {
  FINDINGS_LIMIT,
  useFindingDismiss,
  useFindingReopen,
  useFindings,
  useFindingToTask,
} from "@/lib/findings-queries";
import { formatAgo } from "@/lib/format";
import {
  type FindingGroup,
  GROUPS,
  inGroup,
  SEVERITY_LAMP,
  SEVERITY_WORD,
  sourceLabel,
  sourcesIn,
  taskFindings,
  topFindings,
} from "./findings-model";

const SHOWN_FINDINGS = 3;
const SHOWN_TASKS = 2;

const workspaceName = (orgs: readonly CaptainOrg[], id: string) => orgs.find((o) => o.org === id)?.name ?? id;

/** One line of a finding in the Now column: how bad, what, from where. */
function FindingLine({ finding, workspace }: { finding: Finding; workspace: string | undefined }) {
  return (
    <li className="flex min-w-0 items-center gap-2 border-t border-line py-1.5 first:border-t-0">
      <Lamp state={SEVERITY_LAMP[finding.severity]} size={7} />
      <span className="min-w-0 flex-1 truncate text-base text-fg" title={finding.title}>
        {finding.title}
      </span>
      <span className="shrink-0 text-xs text-fg-faint">{sourceLabel(finding.source)}</span>
      {workspace && (
        <span
          className="max-w-[35%] shrink-0 truncate rounded-full border border-line-control px-2 py-px text-xs text-fg-muted"
          title={workspace}
        >
          {workspace}
        </span>
      )}
    </li>
  );
}

/** "Findings 6 new": the top three open ones, the tasks they became, and See all. */
export function FindingsBox({ orgs, onOpen }: { orgs: readonly CaptainOrg[]; onOpen: () => void }) {
  const query = useFindings();
  const data = query.data;
  const all = data?.findings ?? [];
  const top = topFindings(all, SHOWN_FINDINGS);
  const tasks = taskFindings(all).slice(0, SHOWN_TASKS);
  const names = (org: string) => (orgs.length > 1 ? workspaceName(orgs, org) : undefined);
  return (
    <section aria-label="It noticed" className="flex min-w-0 flex-col border-b border-line px-4 py-3">
      <div className="flex min-h-7 items-center gap-2">
        <h2 className="text-base font-semibold text-fg">It noticed</h2>
        {data !== undefined && <span className="tnum font-mono text-sm text-fg-faint">{data.open}</span>}
        <div className="ml-auto flex items-center gap-2 text-sm">
          <button
            type="button"
            aria-label="All findings"
            onClick={onOpen}
            className="cursor-pointer text-blue hover:underline"
          >
            See all
          </button>
        </div>
      </div>
      {query.isError ? (
        <p className="text-sm text-red">Could not load the findings: {describeError(query.error)}</p>
      ) : data === undefined ? (
        <RowsSkeleton rows={2} height={32} />
      ) : top.length === 0 && tasks.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing new. What the captain notices lands here.</p>
      ) : (
        <>
          {top.length > 0 && (
            <ul className="flex flex-col">
              {top.map((f) => (
                <FindingLine key={f.id} finding={f} workspace={names(f.org)} />
              ))}
            </ul>
          )}
          {data.open > top.length && (
            <button
              type="button"
              onClick={onOpen}
              className="mt-1 cursor-pointer self-start text-sm text-blue hover:underline"
            >
              {data.open - top.length} more open
            </button>
          )}
          {tasks.length > 0 && (
            <ul className="mt-2 flex flex-col">
              {tasks.map((f) => (
                <li key={f.id} className="flex min-w-0 items-baseline gap-2 py-0.5 text-sm text-fg-muted">
                  <span className="shrink-0">{f.status === "proposed" ? "Proposed" : "Task"}</span>
                  {f.task && <TaskRef task={f.task} />}
                  <span className="min-w-0 truncate" title={f.title}>
                    {f.title}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

const ROW_ESTIMATE = 64;

/** One finding in the sheet. Its actions show when it is the selected row. */
function FindingRow({
  finding,
  workspace,
  now,
  selected,
  expanded,
  dismissing,
  onSelect,
  onToggle,
  onMakeTask,
  onStartDismiss,
  onCancelDismiss,
  onDismiss,
  onReopen,
  busy,
  error,
}: {
  finding: Finding;
  workspace: string | undefined;
  now: number;
  selected: boolean;
  expanded: boolean;
  dismissing: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onMakeTask: () => void;
  onStartDismiss: () => void;
  onCancelDismiss: () => void;
  onDismiss: (reason: string) => void;
  onReopen: () => void;
  busy: boolean;
  error: string | undefined;
}) {
  const [reason, setReason] = useState("");
  const live = finding.status === "open" || finding.status === "decision";
  const effort = finding.source === "opportunity" ? opportunityEffort(finding.detail) : undefined;
  return (
    // The list owns the keys (arrows, Enter, t, d); the row only reports clicks.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the listbox that holds the rows
    <div
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      id={`finding-${finding.id}`}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 flex-col gap-1 border-t border-line px-2 py-2",
        selected && "bg-selected/60 shadow-[inset_2px_0_0_var(--c-accent)]",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Lamp state={SEVERITY_LAMP[finding.severity]} size={7} />
        <button
          type="button"
          tabIndex={-1}
          onClick={onToggle}
          aria-expanded={expanded}
          className="min-w-0 flex-1 cursor-pointer truncate text-left text-base text-fg"
          title={finding.title}
        >
          {finding.title}
        </button>
        {finding.task && finding.status !== "fixed" && <TaskRef task={finding.task} />}
        <span className="shrink-0 text-xs text-fg-faint">
          {finding.status === "proposed"
            ? "Proposed"
            : finding.status === "task"
              ? "Task"
              : finding.status === "fixed"
                ? "Fixed"
                : finding.status === "dismissed"
                  ? "Dismissed"
                  : finding.status === "decision"
                    ? "Decision"
                    : SEVERITY_WORD[finding.severity]}
        </span>
      </div>
      <div className="flex min-w-0 items-baseline gap-2 pl-[15px] text-xs text-fg-faint">
        <span className="shrink-0">{sourceLabel(finding.source)}</span>
        {workspace && (
          <span className="max-w-[35%] shrink-0 truncate" title={workspace}>
            {workspace}
          </span>
        )}
        {finding.project && (
          <span className="max-w-[30%] shrink-0 truncate font-mono" title={finding.project}>
            {finding.project}
          </span>
        )}
        <span className="min-w-0 truncate">
          {finding.seen > 1 ? `seen ${finding.seen} times, last ` : "seen "}
          {formatAgo(finding.lastSeen, now)}
        </span>
      </div>
      {finding.status === "dismissed" && finding.dismissedReason && (
        <p className="pl-[15px] text-xs text-fg-muted text-pretty">
          {finding.dismissedBy === undefined ? "Dismissed" : didWords(finding.dismissedBy, "dismissed it")}:{" "}
          {finding.dismissedReason}
        </p>
      )}
      {finding.triage?.injects !== undefined && (
        <p className="pl-[15px] text-xs text-amber text-pretty">
          Flagged: its text tries to instruct an AI agent. No model read it for a verdict.
        </p>
      )}
      {live && finding.triage?.action === "dismiss" && (
        <p className="pl-[15px] text-xs text-fg-muted text-pretty">
          {finding.triage.by === "laya" ? "Laya suggests dismissing" : "Looks like noise"}:{" "}
          {finding.triage.reason}
          {finding.triage.by === "laya" ? ` (${Math.round(finding.triage.confidence * 100)}% sure)` : ""}.
        </p>
      )}
      {selected && live && !dismissing && finding.triage?.action === "dismiss" && (
        <div className="pl-[15px]">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onDismiss(`Laya suggested: ${finding.triage?.reason ?? "noise"}`)}
          >
            Dismiss as suggested
          </Button>
        </div>
      )}
      {selected && finding.status === "dismissed" && finding.triage?.applied === true && (
        <div className="pl-[15px]">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onReopen}>
            Bring back
          </Button>
        </div>
      )}
      {expanded && (
        <div className="flex flex-col gap-1.5 pl-[15px] text-sm text-fg-soft">
          {finding.detail !== "" && (
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-pretty">
              {finding.detail}
            </p>
          )}
          {finding.evidence.length > 0 && (
            <ul className="flex max-h-28 flex-col gap-0.5 overflow-y-auto font-mono text-xs text-fg-muted">
              {finding.evidence.map((e) => (
                <li key={e} className="break-words">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {selected && live && !dismissing && (
        <div className="flex items-center gap-2 pl-[15px] pt-0.5">
          <Button size="sm" variant="secondary" disabled={busy} onClick={onMakeTask}>
            Make a task <Kbd>t</Kbd>
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onStartDismiss}>
            Dismiss <Kbd>d</Kbd>
          </Button>
        </div>
      )}
      {selected && dismissing && (
        <form
          className="flex items-center gap-2 pl-[15px] pt-0.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim() !== "") onDismiss(reason.trim());
          }}
        >
          <Input
            autoFocus
            aria-label="Why dismiss this finding"
            placeholder="Why? (not worth doing, a duplicate, wrong)"
            value={reason}
            maxLength={500}
            className="h-8 flex-1 text-sm"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onCancelDismiss();
              }
            }}
          />
          <Button size="sm" type="submit" disabled={busy || reason.trim() === ""}>
            Dismiss
          </Button>
        </form>
      )}
      {selected && error && (
        <p role="alert" className="pl-[15px] text-xs text-red text-pretty">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The Findings sheet: filters by group, workspace and source, a long list that renders only what is
 * on screen, and the two actions, Make a task and Dismiss with a reason. Keys: arrows or j and k move,
 * Enter opens the detail, t makes a task, d dismisses.
 */
export function FindingsSheet({
  orgs,
  now,
  focus,
}: {
  orgs: readonly CaptainOrg[];
  now: number;
  /** A finding to select first, from a link. */
  focus?: number | undefined;
}) {
  const live = useFindings("live");
  const [group, setGroup] = useState<FindingGroup>("open");
  const wantsHistory = group === "dismissed" || group === "fixed" || group === "all";
  const history = useFindings("history", wantsHistory);
  const query = wantsHistory ? history : live;
  const toTask = useFindingToTask();
  const dismiss = useFindingDismiss();
  const reopen = useFindingReopen();
  const toast = useToast();
  const all = useMemo(() => query.data?.findings ?? [], [query.data]);
  const [org, setOrg] = useState("");
  const [source, setSource] = useState("");
  const [selectedId, setSelectedId] = useState<number | undefined>(focus);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [dismissing, setDismissing] = useState(false);

  // Open and Tasks come from the live list, whose Open is the server's count. The others show a count once read.
  const counts = useMemo(() => {
    const liveRows = live.data?.findings ?? [];
    const historyRows = history.data?.findings;
    const of = (rows: readonly Finding[], g: FindingGroup) => rows.filter((f) => inGroup(f, g)).length;
    const full = historyRows !== undefined && historyRows.length >= FINDINGS_LIMIT;
    const out: Partial<Record<FindingGroup, number>> = {};
    if (live.data !== undefined) {
      out.open = live.data.open;
      out.tasks = of(liveRows, "tasks");
    }
    if (historyRows !== undefined && !full) {
      out.dismissed = of(historyRows, "dismissed");
      out.fixed = of(historyRows, "fixed");
      out.all = historyRows.length;
    }
    return out;
  }, [live.data, history.data]);
  const rows = useMemo(
    () =>
      all.filter(
        (f) => inGroup(f, group) && (org === "" || f.org === org) && (source === "" || f.source === source),
      ),
    [all, group, org, source],
  );
  const sources = useMemo(() => sourcesIn(all), [all]);

  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (i) => rows[i]?.id ?? i,
  });

  // A link to a finding that already has a task opens on Tasks, where it is.
  const placed = useRef(false);
  useEffect(() => {
    if (focus === undefined || placed.current || live.data === undefined) return;
    const found = live.data.findings.find((f) => f.id === focus);
    if (found === undefined) return;
    placed.current = true;
    if (inGroup(found, "tasks")) setGroup("tasks");
  }, [focus, live.data]);

  const index = rows.findIndex((f) => f.id === selectedId);
  const selected = index >= 0 ? rows[index] : undefined;
  // The first row is selected when the list changes, so the keys work at once.
  useEffect(() => {
    if (rows.length > 0 && !rows.some((f) => f.id === selectedId)) setSelectedId(rows[0]?.id);
  }, [rows, selectedId]);

  const move = (to: number) => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
    if (next === undefined) return;
    setSelectedId(next.id);
    setDismissing(false);
    virtual.scrollToIndex(Math.max(0, Math.min(rows.length - 1, to)));
  };
  const makeTask = (f: Finding) =>
    toTask.mutate(
      { id: f.id },
      { onSuccess: (done) => toast("Task made", { detail: `${done.task}: ${f.title}` }) },
    );
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      move(index + 1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      move(index - 1);
    } else if (selected !== undefined && e.key === "Enter") {
      e.preventDefault();
      setExpanded((prev) => {
        const next = new Set(prev);
        if (!next.delete(selected.id)) next.add(selected.id);
        return next;
      });
    } else if (selected !== undefined && (selected.status === "open" || selected.status === "decision")) {
      if (e.key === "t") {
        e.preventDefault();
        makeTask(selected);
      } else if (e.key === "d") {
        e.preventDefault();
        setDismissing(true);
      }
    }
  };

  const error = toTask.error ?? dismiss.error ?? reopen.error;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 pb-2">
        <Segmented
          label="Show findings"
          value={group}
          segments={GROUPS.map((g) => {
            const count = counts[g.value];
            return count === undefined ? g : { ...g, count };
          })}
          onChange={(g) => {
            setGroup(g);
            setDismissing(false);
          }}
        />
        <div className="ml-auto flex items-center gap-2">
          {orgs.length > 1 && (
            <Select
              aria-label="Workspace"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              className="h-8 w-[150px] text-sm"
            >
              <option value="">All workspaces</option>
              {orgs.map((o) => (
                <option key={o.org} value={o.org}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
          <Select
            aria-label="Source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="h-8 w-[130px] text-sm"
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {query.isError ? (
        <p role="alert" className="pt-2 text-sm text-red">
          Could not load the findings: {describeError(query.error)}
        </p>
      ) : query.data === undefined ? (
        <RowsSkeleton rows={5} height={52} />
      ) : rows.length === 0 ? (
        <p className="pt-2 text-sm text-fg-faint text-pretty">
          {all.length === 0
            ? "Nothing yet. What the captain and your agents notice lands here, once, however often it is seen."
            : "Nothing here under this filter."}
        </p>
      ) : (
        <>
          <div
            ref={scroller}
            role="listbox"
            aria-label="Findings"
            aria-activedescendant={selected === undefined ? undefined : `finding-${selected.id}`}
            // The listbox is the one tab stop; the keys move inside it.
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md outline-none focus-visible:shadow-[0_0_0_1px_var(--c-accent)]"
          >
            <div style={{ height: virtual.getTotalSize() }} className="relative w-full">
              {virtual.getVirtualItems().map((item) => {
                const f = rows[item.index];
                if (f === undefined) return null;
                return (
                  <div
                    key={item.key}
                    ref={virtual.measureElement}
                    data-index={item.index}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <FindingRow
                      finding={f}
                      workspace={orgs.length > 1 ? workspaceName(orgs, f.org) : undefined}
                      now={now}
                      selected={f.id === selectedId}
                      expanded={expanded.has(f.id)}
                      dismissing={dismissing && f.id === selectedId}
                      busy={toTask.isPending || dismiss.isPending || reopen.isPending}
                      error={f.id === selectedId && error ? describeError(error) : undefined}
                      onSelect={() => {
                        setSelectedId(f.id);
                        setDismissing(false);
                        toTask.reset();
                        dismiss.reset();
                      }}
                      onToggle={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (!next.delete(f.id)) next.add(f.id);
                          return next;
                        })
                      }
                      onMakeTask={() => makeTask(f)}
                      onStartDismiss={() => setDismissing(true)}
                      onCancelDismiss={() => setDismissing(false)}
                      onReopen={() =>
                        reopen.mutate(
                          { id: f.id },
                          { onSuccess: () => toast("Brought back", { detail: f.title }) },
                        )
                      }
                      onDismiss={(reason) =>
                        dismiss.mutate(
                          { id: f.id, reason },
                          {
                            onSuccess: () => {
                              setDismissing(false);
                              toast("Dismissed", { detail: f.title });
                            },
                          },
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
          <p className="shrink-0 pt-2 text-xs text-fg-faint">
            <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> details · <Kbd>t</Kbd> make a task ·{" "}
            <Kbd>d</Kbd> dismiss
          </p>
        </>
      )}
    </div>
  );
}
