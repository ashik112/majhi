import {
  type OpsIncident,
  type OpsServiceView,
  PRIVATE,
  WATCH_KIND_LABEL,
  WATCH_KINDS,
  type WatchDef,
  type WatchPlan,
} from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BellRing, Radar, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { DetailPane, ListDetail } from "@/components/ui/list-detail";
import { Select } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import { useWatch, useWatches } from "@/lib/watch-queries";
import type { AppSearch } from "@/router";
import { AlertsSheet } from "./alerts-sheet";
import { IncidentDetail, ServiceDetail } from "./detail";
import {
  type Row,
  type RowSort,
  SORT_ICON,
  STATUS_LAMP,
  selfRow,
  serviceRow,
  sortRows,
  watchRow,
} from "./rows";
import { ServiceForm } from "./service-form";
import { WatchDetail } from "./watch-detail";
import { WatchForm } from "./watch-form";
import { SentenceBox } from "./watch-plan";

type StatusFilter = "all" | "alerting" | "fine" | "paused";

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm whitespace-nowrap",
        on ? "border-accent/40 bg-accent-wash text-fg" : "border-line text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

const GRID = "grid grid-cols-[20px_minmax(88px,1fr)_76px_minmax(0,112px)_96px] items-center gap-2.5";

function RowLine({
  row,
  selected,
  workspace,
  onSelect,
}: {
  row: Row;
  selected: boolean;
  workspace: string;
  onSelect: () => void;
}) {
  const Icon = SORT_ICON[row.sort];
  const alerting = (row.status === "alerting" || row.status === "changed") && row.acked !== true;
  return (
    <button
      type="button"
      data-watch={row.key}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        GRID,
        "h-10 w-full cursor-pointer rounded-lg border-b border-line px-2 text-left text-base hover:bg-raised",
        selected && "bg-accent-wash",
      )}
    >
      <Icon aria-hidden="true" className="size-4 text-fg-muted" />
      <span className={cn("truncate text-fg", alerting && "font-medium")} title={row.name}>
        {row.name}
      </span>
      <span className="truncate rounded-md border border-line px-1.5 text-xs text-fg-soft" title={workspace}>
        {workspace}
      </span>
      <span className="tnum truncate text-right font-mono text-sm text-fg-soft" title={row.value}>
        {row.value}
      </span>
      <span
        className={cn(
          "flex items-center justify-end gap-1.5 text-sm",
          alerting ? "text-red" : "text-fg-soft",
        )}
      >
        <Lamp state={row.acked === true ? "paused" : STATUS_LAMP[row.status]} size={6} />
        <span className="truncate" title={row.word}>
          {row.acked === true
            ? "Acknowledged"
            : row.watch?.transition?.kind === "confirming"
              ? "Confirming"
              : row.word}
        </span>
      </span>
    </button>
  );
}

/**
 * The Watch page (`/watch`, SPEC 5.18): anything the owner wants to know about, on one list. A sentence
 * starts a watch; the rows say what each one reads now; the detail shows its history, what the captain
 * found, what happens when it fires and how it checks. Services watched the older way and majhi's own
 * incidents stay in the list.
 */
export function WatchView() {
  const ops = useWatch();
  const watches = useWatches();
  const orgs = useOrgs().data ?? [];
  const { org: orgFilter } = useOrgFilter();
  const now = useNow(30_000);
  const narrow = useMedia("(max-width: 999px)");
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState(false);
  const [serviceForm, setServiceForm] = useState<{ service?: OpsServiceView } | undefined>();
  const [form, setForm] = useState<
    { watch?: { id: string; org: string; def: WatchDef }; start?: { org: string; def: WatchDef } } | undefined
  >();
  const [sort, setSort] = useState<RowSort | "all">("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [ws, setWs] = useState("");
  const [query, setQuery] = useState("");
  const nameOf = useMemo(() => {
    const names = new Map<string, string>([[PRIVATE, "Private"]]);
    for (const o of orgs) names.set(o.id, o.name);
    return (org: string) => names.get(org) ?? org;
  }, [orgs]);

  const data = ops.data;
  const anything = watches.data;
  const inOrg = (org: string) => (orgFilter === undefined || org === orgFilter) && (ws === "" || org === ws);

  const ackedIncident = new Set(
    [...(data?.incidents ?? []), ...(anything?.incidents ?? [])]
      .filter((i) => i.status === "open" && i.ackedAt !== undefined)
      .map((i) => i.id),
  );
  const markAcked = (r: Row): Row => {
    const id = r.incident?.id ?? r.watch?.incident ?? r.service?.incident;
    return id !== undefined && ackedIncident.has(id) ? { ...r, acked: true } : r;
  };
  const all: Row[] = [
    ...(anything?.watches ?? []).map(watchRow),
    ...(data?.services ?? []).map(serviceRow),
    ...(data?.incidents ?? [])
      .filter((i) => i.status === "open" && i.service === undefined && i.watch === undefined)
      .map(selfRow),
  ]
    .map(markAcked)
    .filter((r) => inOrg(r.org));
  const q = query.trim().toLowerCase();
  const matches = (r: Row) =>
    (status === "all" ||
      (status === "alerting" && (r.status === "alerting" || r.status === "changed") && r.acked !== true) ||
      (status === "paused" && r.status === "paused") ||
      (status === "fine" && r.status === "ok")) &&
    (q === "" || r.name.toLowerCase().includes(q) || nameOf(r.org).toLowerCase().includes(q));
  const bySort = (r: Row) => sort === "all" || r.sort === sort;
  const rows = sortRows(all.filter((r) => matches(r) && bySort(r)));
  const counts = (pick: (r: Row) => boolean) => all.filter((r) => pick(r) && matches(r)).length;
  const alerting = all.filter(
    (r) => (r.status === "alerting" || r.status === "changed") && r.acked !== true,
  ).length;
  const acknowledged = all.filter((r) => r.acked === true).length;
  const paused = all.filter((r) => r.status === "paused").length;
  const fine = all.filter((r) => r.status === "ok").length;

  const workspaces = [
    ...new Set([...(anything?.watches ?? []).map((w) => w.org), ...(data?.services ?? []).map((s) => s.org)]),
  ];
  const hasSelf = all.some((r) => r.sort === "majhi");

  const wanted = search.id;
  const effective = wanted ?? (narrow ? undefined : rows[0]?.key);
  const shown = all.find((r) => r.key === effective);

  const select = (id: string | undefined) =>
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => {
        const { id: _drop, ...rest } = prev;
        return id === undefined ? rest : { ...rest, id };
      },
      replace: true,
    });

  const incidents: OpsIncident[] = [...(data?.incidents ?? []), ...(anything?.incidents ?? [])];
  const defaultOrg = orgFilter ?? PRIVATE;
  const back = narrow ? () => select(undefined) : undefined;

  const detail = (() => {
    if (shown === undefined) return null;
    if (shown.watch !== undefined) {
      const w = shown.watch;
      return (
        <WatchDetail
          key={w.id}
          watch={w}
          incident={incidents.find((i) => i.id === w.incident)}
          now={now}
          workspace={nameOf(w.org)}
          phoneOn={data?.phone.state === "on"}
          onSetUpPhone={() => setAlerts(true)}
          onEdit={() => setForm({ watch: { id: w.id, org: w.org, def: w.def } })}
          onBack={back}
        />
      );
    }
    if (shown.service !== undefined && data !== undefined) {
      const s = shown.service;
      return (
        <ServiceDetail
          key={s.id}
          service={s}
          incident={data.incidents.find((i) => i.id === s.incident)}
          past={data.incidents.filter((i) => i.service === s.id && i.status === "resolved").slice(0, 6)}
          now={now}
          workspace={nameOf(s.org)}
          onEdit={() => setServiceForm({ service: s })}
          onBack={back}
        />
      );
    }
    if (shown.incident !== undefined) {
      return (
        <IncidentDetail
          key={shown.incident.id}
          incident={shown.incident}
          now={now}
          workspace={nameOf(shown.incident.org)}
          onBack={back}
        />
      );
    }
    return null;
  })();

  let body: React.ReactNode;
  if (ops.isError || watches.isError) {
    body = (
      <Problem
        icon={<Radar />}
        title="Could not load Watch"
        body={describeError(ops.error ?? watches.error)}
      />
    );
  } else if (data === undefined || anything === undefined) {
    body = <RowsSkeleton rows={6} height={40} />;
  } else {
    const sortChips = WATCH_KINDS.map((k) => ({ k, n: counts((r) => r.sort === k) })).filter((c) => c.n > 0);
    const list = (
      <nav
        aria-label="Watches"
        className={cn(
          "flex min-w-0 flex-[1.35] flex-col overflow-hidden rounded-2xl max-[999px]:w-full",
          GLASS,
        )}
      >
        <SentenceBox
          org={orgFilter}
          onManual={() => setForm({})}
          onEdit={(plan: WatchPlan) => setForm({ start: { org: plan.org, def: plan.def } })}
        />
        <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip on={sort === "all"} onClick={() => setSort("all")}>
              All {counts(() => true)}
            </Chip>
            {sortChips.map(({ k, n }) => {
              const Icon = SORT_ICON[k];
              return (
                <Chip key={k} on={sort === k} onClick={() => setSort(k)}>
                  <Icon aria-hidden="true" className="size-3.5" />
                  {WATCH_KIND_LABEL[k]} {n}
                </Chip>
              );
            })}
            {hasSelf && (
              <Chip on={sort === "majhi"} onClick={() => setSort("majhi")}>
                majhi itself {counts((r) => r.sort === "majhi")}
              </Chip>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              on={status === "alerting"}
              onClick={() => setStatus(status === "alerting" ? "all" : "alerting")}
            >
              {alerting > 0 && <Lamp state="needs" size={6} />}
              Alerting {alerting}
            </Chip>
            <Chip on={status === "fine"} onClick={() => setStatus(status === "fine" ? "all" : "fine")}>
              Fine {fine}
            </Chip>
            <Chip on={status === "paused"} onClick={() => setStatus(status === "paused" ? "all" : "paused")}>
              Paused {paused}
            </Chip>
            {workspaces.length > 1 && (
              <Select
                aria-label="Workspace"
                value={ws}
                onChange={(e) => setWs(e.target.value)}
                className="h-[26px] w-auto text-sm"
              >
                <option value="">All workspaces</option>
                {workspaces.map((o) => (
                  <option key={o} value={o}>
                    {nameOf(o)}
                  </option>
                ))}
              </Select>
            )}
            <label className="relative ml-auto flex min-w-[160px] items-center">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2 size-3.5 text-fg-faint"
              />
              <input
                aria-label="Search watches"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search watches"
                className="h-[26px] w-full rounded-md border border-line bg-field pr-2 pl-7 text-sm text-fg placeholder:text-fg-faint"
              />
            </label>
          </div>
        </div>
        <div className={cn(GRID, "shrink-0 px-4 pt-1.5 pb-1 text-xs tracking-wider text-fg-faint uppercase")}>
          <span />
          <span>Watching</span>
          <span>Workspace</span>
          <span className="text-right">Now</span>
          <span className="text-right">Status</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 pb-2 scroll-fade">
          {rows.map((r) => (
            <RowLine
              key={r.key}
              row={r}
              selected={r.key === effective}
              workspace={nameOf(r.org)}
              onSelect={() => select(r.key)}
            />
          ))}
          {rows.length === 0 && (
            <p className="m-0 px-2 pt-2 text-sm text-fg-faint">
              {all.length === 0
                ? "Nothing is watched yet. Say what to watch in the box above."
                : "Nothing here."}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
          <Button size="sm" onClick={() => setServiceForm({})}>
            Watch a service
          </Button>
          <span className="ml-auto truncate font-mono text-xs text-fg-faint">
            {data.phone.state === "on"
              ? `Phone: on · escalates after ${data.settings.escalateMin} m`
              : `Phone: ${data.phone.state}`}
          </span>
        </div>
      </nav>
    );
    body = (
      <ListDetail className="[&>*]:min-w-0 [&>nav]:basis-0 [&>section]:basis-0">
        {narrow ? (detail ?? list) : list}
        {!narrow &&
          (detail ?? (
            <DetailPane label="Watch">
              <p className="m-0 pt-6 text-base text-fg-soft">Pick a watch to see its history.</p>
            </DetailPane>
          ))}
      </ListDetail>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        className={cn(
          "mb-3 flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl px-4 py-2",
          GLASS,
        )}
      >
        <h1 className="text-md leading-5 font-semibold text-fg">Watch</h1>
        {data !== undefined && anything !== undefined && (
          <>
            {alerting > 0 && <span className="text-base text-red">{alerting} alerting</span>}
            {acknowledged > 0 && <span className="text-base text-fg-muted">{acknowledged} acknowledged</span>}
            <span className="text-base text-fg-muted">{fine} fine</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" onClick={() => setAlerts(true)}>
            <BellRing aria-hidden="true" />
            Alerts and phone
          </Button>
        </div>
      </header>
      {body}
      {form !== undefined && (
        <WatchForm
          key={form.watch?.id ?? (form.start === undefined ? "new" : "plan")}
          watch={form.watch}
          start={form.start}
          org={defaultOrg}
          onClose={() => setForm(undefined)}
        />
      )}
      {serviceForm !== undefined && (
        <ServiceForm
          {...(serviceForm.service === undefined ? {} : { service: serviceForm.service })}
          org={defaultOrg}
          onClose={() => setServiceForm(undefined)}
        />
      )}
      {alerts && data !== undefined && (
        <AlertsSheet phone={data.phone} settings={data.settings} onClose={() => setAlerts(false)} />
      )}
    </div>
  );
}
