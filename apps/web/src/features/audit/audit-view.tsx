import type { AuditEntry } from "@majhi/shared";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Dot, toneText } from "@/components/ui/status-dot";
import { GridRow, RowsPanel } from "@/features/automations/parts";
import { useAuditLog } from "@/lib/audit-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { PAGE_PATH } from "@/lib/pages";
import {
  type AuditFilters,
  DECISION_LABELS,
  DECISIONS,
  decisionTone,
  detailParts,
  filtersFromSearch,
  hasFilters,
  kindLabel,
  searchFromFilters,
  timeText,
  validTask,
} from "./model";

const COLUMNS = "140px 80px 80px 120px minmax(150px,1fr) 100px 130px minmax(200px,1.4fr)";
const HEADS = ["Time", "Org", "Task", "Kind", "What", "Decision", "By", "Detail"];

/**
 * The audit log: what majhi pushed, merged and was allowed to do, newest first. The filters live in
 * the address, so a filtered view can be linked. The table scrolls inside the page, never the page.
 */
export function AuditView() {
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const filters = filtersFromSearch(search);
  const log = useAuditLog(filters);
  const pages = log.data?.pages ?? [];
  const entries = pages.flatMap((p) => p.entries);
  // Every page lists the same kinds, agents and orgs, so the newest read is enough.
  const lists = pages[0];

  function change(next: AuditFilters) {
    void navigate({ to: PAGE_PATH.audit, search: searchFromFilters(next), replace: true });
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Audit log" subtitle="What majhi pushed, merged and was allowed to do, newest first.">
        <Button size="lg" disabled={!hasFilters(filters)} onClick={() => change({})}>
          Clear filters
        </Button>
      </PageHeader>

      <Filters
        filters={filters}
        orgs={lists?.orgs ?? []}
        agents={lists?.agents ?? []}
        kinds={lists?.kinds ?? []}
        onChange={change}
      />

      <span role="status" className="sr-only">
        {log.isFetching ? "Loading the log" : `${entries.length} entries shown`}
      </span>

      {log.isError && (
        <p role="alert" className="mb-2 px-1 text-base text-red">
          Could not read the audit log: {describeError(log.error)}
        </p>
      )}

      <RowsPanel label="Audit log" columns={COLUMNS} heads={HEADS}>
        {log.isPending ? (
          <li className="px-4 py-6 text-base text-fg-muted">Loading the log</li>
        ) : entries.length === 0 ? (
          <li className="flex flex-col items-start gap-2 px-4 py-6 text-base text-fg-muted">
            {hasFilters(filters)
              ? "Nothing in the log matches these filters."
              : "Nothing is logged yet. Pushes, merge requests, merges, permission decisions and approvals appear here."}
            {hasFilters(filters) && (
              <Button size="sm" onClick={() => change({})}>
                Clear filters
              </Button>
            )}
          </li>
        ) : (
          entries.map((entry) => <Row key={entry.id} entry={entry} />)
        )}
        {entries.length > 0 && (
          <li className="flex items-center gap-3 px-4 py-3 text-sm text-fg-faint">
            {log.hasNextPage ? (
              <Button size="sm" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                {log.isFetchingNextPage && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                Load older
              </Button>
            ) : (
              <span>That is everything.</span>
            )}
            <span>{entries.length} shown</span>
          </li>
        )}
      </RowsPanel>
    </div>
  );
}

function Row({ entry }: { entry: AuditEntry }) {
  const tone = decisionTone(entry.decision);
  return (
    <GridRow columns={COLUMNS}>
      <time dateTime={entry.at} title={entry.at} className="tnum text-sm text-fg-soft">
        {timeText(entry.at)}
      </time>
      <span className="truncate font-mono text-sm text-fg-soft" title={entry.org}>
        {entry.org ?? ""}
      </span>
      <Link
        to="/t/$taskId"
        params={{ taskId: entry.task }}
        search={{}}
        className="truncate rounded-xs font-mono text-sm text-fg-soft underline-offset-2 hover:text-fg hover:underline"
      >
        {entry.task}
      </Link>
      <span className="truncate text-sm text-fg" title={entry.kind}>
        {kindLabel(entry.kind)}
      </span>
      <span className="line-clamp-2 text-sm text-fg-soft text-pretty" title={entry.title}>
        {entry.title}
      </span>
      <span className={cn("flex items-center gap-1.5 text-sm font-medium", toneText(tone))}>
        <Dot tone={tone} size={7} />
        {DECISION_LABELS[entry.decision]}
      </span>
      <span className="flex min-w-0 flex-col text-sm text-fg-soft">
        <span className="truncate">{entry.by}</span>
        {entry.agent !== entry.by && (
          <span className="truncate font-mono text-xs text-fg-faint" title={entry.agent}>
            {entry.agent}
          </span>
        )}
      </span>
      <span className="line-clamp-3 text-sm break-words text-fg-muted text-pretty" title={entry.detail}>
        {entry.detail === undefined
          ? ""
          : detailParts(entry.detail).map((part, i) =>
              part.href === undefined ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
                <span key={i}>{part.text}</span>
              ) : (
                <a
                  // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
                  key={i}
                  href={part.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent underline underline-offset-2 hover:text-accent-hover"
                >
                  {part.text}
                </a>
              ),
            )}
      </span>
    </GridRow>
  );
}

function Filters({
  filters,
  orgs,
  agents,
  kinds,
  onChange,
}: {
  filters: AuditFilters;
  orgs: readonly string[];
  agents: readonly string[];
  kinds: readonly string[];
  onChange: (next: AuditFilters) => void;
}) {
  // The task field keeps what is typed; the address gets it once it is a task id.
  const [task, setTask] = useState(filters.task ?? "");
  useEffect(() => setTask(filters.task ?? ""), [filters.task]);
  const bad = task.trim() !== "" && validTask(task) === undefined;

  const set = (patch: { [K in keyof AuditFilters]?: AuditFilters[K] | undefined }) => {
    // The cleared fields are undefined here and deleted just below.
    const next = { ...filters, ...patch } as AuditFilters;
    for (const key of Object.keys(next) as (keyof AuditFilters)[]) {
      const value = next[key];
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0))
        delete next[key];
    }
    onChange(next);
  };

  return (
    <search
      aria-label="Filter the audit log"
      className="mb-3 grid shrink-0 grid-cols-2 items-end gap-x-3 gap-y-2 min-[900px]:grid-cols-4 min-[1280px]:grid-cols-7"
    >
      <Labelled label="Org">
        {(id) => (
          <Select id={id} value={filters.org ?? ""} onChange={(e) => set({ org: e.target.value })}>
            <option value="">All orgs</option>
            {orgs.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
            {filters.org !== undefined && !orgs.includes(filters.org) && (
              <option value={filters.org}>{filters.org}</option>
            )}
          </Select>
        )}
      </Labelled>
      <Labelled label="Task">
        {(id) => (
          <Input
            id={id}
            value={task}
            placeholder="GLX-420"
            aria-invalid={bad ? true : undefined}
            title={bad ? "Task ids look like GLX-420" : undefined}
            onChange={(e) => {
              setTask(e.target.value);
              const id = validTask(e.target.value);
              if (id !== undefined) set({ task: id });
              else if (e.target.value.trim() === "") set({ task: undefined });
            }}
            className="font-mono"
          />
        )}
      </Labelled>
      <Labelled label="Kind">
        {() => (
          <MultiSelect
            label="Kind"
            options={kinds.map((k) => ({ value: k, label: kindLabel(k) }))}
            value={filters.kinds ?? []}
            onChange={(next) => set({ kinds: next })}
            emptyText="Every kind"
            clearText="Every kind"
          />
        )}
      </Labelled>
      <Labelled label="Agent">
        {(id) => (
          <Select id={id} value={filters.agent ?? ""} onChange={(e) => set({ agent: e.target.value })}>
            <option value="">Every agent</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
            {filters.agent !== undefined && !agents.includes(filters.agent) && (
              <option value={filters.agent}>{filters.agent}</option>
            )}
          </Select>
        )}
      </Labelled>
      <Labelled label="Decision">
        {(id) => (
          <Select
            id={id}
            value={filters.decision ?? ""}
            onChange={(e) => set({ decision: DECISIONS.find((d) => d === e.target.value) })}
          >
            <option value="">Any decision</option>
            {DECISIONS.map((d) => (
              <option key={d} value={d}>
                {DECISION_LABELS[d]}
              </option>
            ))}
          </Select>
        )}
      </Labelled>
      <Labelled label="From">
        {(id) => (
          <Input
            id={id}
            type="date"
            value={filters.from ?? ""}
            max={filters.to}
            onChange={(e) => set({ from: e.target.value })}
          />
        )}
      </Labelled>
      <Labelled label="To">
        {(id) => (
          <Input
            id={id}
            type="date"
            value={filters.to ?? ""}
            min={filters.from}
            onChange={(e) => set({ to: e.target.value })}
          />
        )}
      </Labelled>
    </search>
  );
}

/** A small label over a control. The control gets the id that ties them. */
function Labelled({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = `audit-${label.toLowerCase()}`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm text-fg-faint">
        {label}
      </label>
      {children(id)}
    </div>
  );
}
