import { type OpsIncident, type OpsServiceView, PRIVATE } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BellRing, Plus, Radar } from "lucide-react";
import { useMemo, useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { DetailPane, ListDetail } from "@/components/ui/list-detail";
import { Select } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import { useAckIncident, useWatch } from "@/lib/watch-queries";
import type { AppSearch } from "@/router";
import { AlertsSheet } from "./alerts-sheet";
import { IncidentDetail, ServiceDetail } from "./detail";
import { CHECK_LAMP, CHECK_WORD, incidentLamp, incidentWord, spanText } from "./model";
import { ServiceForm } from "./service-form";

const incidentId = (n: number) => `inc-${n}`;

type Filter = "all" | "down" | "incidents" | "self";

/** One line for the card: the 24 hour latency as a thin polyline, red when the service is down. */
function MiniSpark({
  samples,
  down,
  now,
}: {
  samples: OpsServiceView["samples"];
  down: boolean;
  now: number;
}) {
  const points = samples.filter((s) => s.ok && s.ms !== null);
  if (points.length < 2) return null;
  const start = now - 24 * 3_600_000;
  const slowest = Math.max(100, ...points.map((s) => s.ms ?? 0));
  const line = points
    .map((s) => {
      const x = Math.max(0, Math.min(120, ((Date.parse(s.at) - start) / (24 * 3_600_000)) * 120));
      const y = 20 - ((s.ms ?? 0) / slowest) * 18;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg aria-hidden="true" viewBox="0 0 120 22" className="h-[22px] w-[120px]">
      <polyline
        points={line}
        fill="none"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        className={down ? "stroke-red" : "stroke-lamp-done"}
      />
    </svg>
  );
}

const CARD =
  "flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-[10px] border border-line bg-raised px-3 py-2.5 text-left";

function ServiceCard({
  service,
  incident,
  selected,
  now,
  workspace,
  onSelect,
  onOpenIncident,
}: {
  service: OpsServiceView;
  incident: OpsIncident | undefined;
  selected: boolean;
  now: number;
  workspace: string;
  onSelect: () => void;
  onOpenIncident: () => void;
}) {
  const ack = useAckIncident();
  const toast = useToast();
  const down = service.status === "down";
  const url = service.checks.find((c) => c.kind === "url");
  const warn = service.checks.find((c) => (c.kind === "tls" || c.kind === "dns") && c.status !== "up");
  const needsAck = incident !== undefined && incident.status === "open" && incident.ackedAt === undefined;
  return (
    // biome-ignore lint/a11y/useSemanticElements: the card holds buttons, so it cannot be one
    <div
      role="button"
      tabIndex={0}
      data-service={service.id}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        CARD,
        down && "border-lamp-needs/30 bg-lamp-needs/5",
        selected && "border-accent/40 bg-accent-wash",
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm text-fg-faint">
        <Lamp state={CHECK_LAMP[service.status]} size={7} />
        <span className={cn("shrink-0", down && "font-semibold text-red")}>
          {down && incident ? `Down ${spanText(incident.openedAt, now)}` : CHECK_WORD[service.status]}
        </span>
        <span className="truncate rounded-md border border-line px-1.5 text-xs text-fg-soft">
          {workspace}
        </span>
        <span className="tnum ml-auto shrink-0 truncate font-mono text-xs">
          {warn ? <span className="text-amber-soft">{warn.detail}</span> : url ? url.detail : null}
        </span>
      </span>
      <span className="truncate text-base font-medium text-fg" title={service.def.url}>
        {service.def.name} · {service.def.url.replace(/^https?:\/\//, "")}
      </span>
      <MiniSpark samples={service.samples} down={down} now={now} />
      {needsAck && incident && (
        <span className="flex gap-1.5 pt-1">
          <Button
            size="sm"
            variant="primary"
            disabled={ack.isPending}
            onClick={(e) => {
              e.stopPropagation();
              ack.mutate(incident.id, {
                onError: (err) =>
                  toast("Could not acknowledge it", { detail: describeError(err), tone: "error" }),
              });
            }}
          >
            Acknowledge
          </Button>
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onOpenIncident();
            }}
          >
            Open incident
          </Button>
        </span>
      )}
    </div>
  );
}

/** A majhi-itself incident (no service): the same card, a title and its state. */
function SelfCard({
  incident,
  selected,
  now,
  onSelect,
}: {
  incident: OpsIncident;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-incident={incident.id}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        CARD,
        incident.status === "open" && "border-lamp-needs/30",
        selected && "border-accent/40 bg-accent-wash",
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm text-fg-faint">
        <Lamp state={incidentLamp(incident)} size={7} />
        <span>{incidentWord(incident)}</span>
        <span className="truncate rounded-md border border-line px-1.5 text-xs text-fg-soft">majhi</span>
        <span className="ml-auto shrink-0 text-xs">{formatAgo(incident.openedAt, now)}</span>
      </span>
      <span className="truncate text-base font-medium text-fg">{incident.title}</span>
    </button>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm",
        on ? "border-accent/40 bg-accent-wash text-fg" : "border-line text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The Watch page (`/watch`, SPEC 5.18, Ops watch): what is watched and how it is doing, the incidents,
 * and the alerts. Incidents first, since they are what needs the owner, then the services of each
 * workspace with the ones that are not up on top. The selected one fills the right side. Below 1000px
 * the pane is the page and the list its back view.
 */
export function WatchView() {
  const query = useWatch();
  const orgs = useOrgs().data ?? [];
  const { org: filter } = useOrgFilter();
  const now = useNow(30_000);
  const narrow = useMedia("(max-width: 999px)");
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const [form, setForm] = useState<{ service?: OpsServiceView } | undefined>();
  const [alerts, setAlerts] = useState(false);
  const nameOf = useMemo(() => {
    const names = new Map<string, string>([[PRIVATE, "Private"]]);
    for (const o of orgs) names.set(o.id, o.name);
    return (org: string) => names.get(org) ?? org;
  }, [orgs]);

  const data = query.data;
  const [filter2, setFilter2] = useState<Filter>("all");
  const [ws, setWs] = useState("");
  const inOrg = (org: string) => (filter === undefined || org === filter) && (ws === "" || org === ws);
  const allServices = (data?.services ?? []).filter((s) => inOrg(s.org));
  const incidents = (data?.incidents ?? []).filter((i) => inOrg(i.org));
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const open = incidents
    .filter((i) => i.status === "open")
    .toSorted((a, b) => rank[a.severity] - rank[b.severity] || b.id - a.id);
  const openOf = (s: OpsServiceView) => open.find((i) => i.service === s.id);
  const selfOpen = open.filter((i) => i.service === undefined);
  const order = { down: 0, checking: 1, unknown: 2, new: 3, up: 4 } as const;
  const sorted = allServices.toSorted(
    (a, b) => order[a.status] - order[b.status] || a.def.name.localeCompare(b.def.name),
  );
  const downCount = allServices.filter((s) => s.status === "down").length;
  const services =
    filter2 === "down"
      ? sorted.filter((s) => s.status === "down")
      : filter2 === "incidents"
        ? sorted.filter((s) => openOf(s) !== undefined)
        : filter2 === "self"
          ? []
          : sorted;
  const selfShown =
    filter2 === "all" || filter2 === "self" || filter2 === "incidents"
      ? filter2 === "incidents"
        ? selfOpen
        : selfOpen
      : [];
  const count = allServices.length + selfOpen.length;
  const workspaces = [...new Set((data?.services ?? []).map((s) => s.org))];

  const wanted = search.id;
  const effective =
    wanted ??
    (narrow ? undefined : (services[0]?.id ?? (selfShown[0] ? incidentId(selfShown[0].id) : undefined)));
  const shownService = allServices.find((s) => s.id === effective);
  const shownIncident = incidents.find((i) => incidentId(i.id) === effective);

  const select = (id: string | undefined) =>
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => {
        const { id: _drop, ...rest } = prev;
        return id === undefined ? rest : { ...rest, id };
      },
      replace: true,
    });

  const defaultOrg = filter ?? PRIVATE;
  let body: React.ReactNode;
  if (query.isError) {
    body = <Problem icon={<Radar />} title="Could not load Watch" body={describeError(query.error)} />;
  } else if (data === undefined) {
    body = <RowsSkeleton rows={5} height={52} />;
  } else if (count === 0 && incidents.length === 0) {
    body = (
      <DetailPane label="Watch">
        <div className="flex flex-col items-start gap-3 pt-6">
          <p className="m-0 text-base text-fg-soft">Nothing is watched yet.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => setForm({})}>
              <Plus aria-hidden="true" />
              Watch a service
            </Button>
            <Button onClick={() => setAlerts(true)}>
              <BellRing aria-hidden="true" />
              Alerts and phone
            </Button>
          </div>
        </div>
      </DetailPane>
    );
  } else {
    const list = (
      <nav
        aria-label="Watched services and incidents"
        className={cn("flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl max-[999px]:w-full", GLASS)}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2.5">
          <Chip on={filter2 === "all"} onClick={() => setFilter2("all")}>
            All {count}
          </Chip>
          <Chip on={filter2 === "down"} onClick={() => setFilter2("down")}>
            {downCount > 0 && <Lamp state="needs" size={6} />}
            Down {downCount}
          </Chip>
          <Chip on={filter2 === "incidents"} onClick={() => setFilter2("incidents")}>
            Incidents {open.length}
          </Chip>
          <Chip on={filter2 === "self"} onClick={() => setFilter2("self")}>
            majhi itself
          </Chip>
          {workspaces.length > 1 && (
            <Select
              aria-label="Workspace"
              value={ws}
              onChange={(e) => setWs(e.target.value)}
              className="ml-auto h-[26px] w-auto text-sm"
            >
              <option value="">All workspaces</option>
              {workspaces.map((o) => (
                <option key={o} value={o}>
                  {nameOf(o)}
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain p-2 scroll-fade">
          {services.map((s) => {
            const inc = openOf(s);
            return (
              <ServiceCard
                key={s.id}
                service={s}
                incident={inc}
                selected={s.id === effective || (inc !== undefined && incidentId(inc.id) === effective)}
                now={now}
                workspace={nameOf(s.org)}
                onSelect={() => select(s.id)}
                onOpenIncident={() => inc && select(incidentId(inc.id))}
              />
            );
          })}
          {selfShown.map((i) => (
            <SelfCard
              key={i.id}
              incident={i}
              selected={incidentId(i.id) === effective}
              now={now}
              onSelect={() => select(incidentId(i.id))}
            />
          ))}
          {services.length === 0 && selfShown.length === 0 && (
            <p className="m-0 px-1 text-sm text-fg-faint">Nothing here.</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
          <Button size="sm" onClick={() => setForm({})}>
            <Plus aria-hidden="true" />
            Watch a service
          </Button>
          <Button size="sm" onClick={() => setAlerts(true)}>
            <BellRing aria-hidden="true" />
            Alerts and phone
          </Button>
          <span className="ml-auto truncate font-mono text-xs text-fg-faint">
            {data.phone.state === "on"
              ? `Phone: on · escalates after ${data.settings.escalateMin} m`
              : `Phone: ${data.phone.state}`}
          </span>
        </div>
      </nav>
    );
    const back = narrow ? () => select(undefined) : undefined;
    const pane =
      shownService !== undefined ? (
        <ServiceDetail
          key={shownService.id}
          service={shownService}
          incident={data.incidents.find((i) => i.id === shownService.incident)}
          past={data.incidents
            .filter((i) => i.service === shownService.id && i.status === "resolved")
            .slice(0, 6)}
          now={now}
          workspace={nameOf(shownService.org)}
          onEdit={() => setForm({ service: shownService })}
          onBack={back}
        />
      ) : shownIncident !== undefined ? (
        <IncidentDetail
          key={shownIncident.id}
          incident={shownIncident}
          now={now}
          workspace={nameOf(shownIncident.org)}
          onBack={back}
        />
      ) : null;
    body = (
      <ListDetail className="[&>*]:min-w-0 [&>nav]:basis-0 [&>section]:basis-0">
        {narrow ? (pane ?? list) : list}
        {!narrow && pane}
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
        {data !== undefined && downCount > 0 && <span className="text-base text-red">{downCount} down</span>}
        {data !== undefined && (
          <span className="text-base text-fg-muted">
            {allServices.length - downCount} up
            {open.length > 0 ? ` · ${open.length} ${open.length === 1 ? "incident" : "incidents"} open` : ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" onClick={() => setForm({})}>
            <Plus aria-hidden="true" />
            Watch a service
          </Button>
          <Button size="sm" onClick={() => setAlerts(true)}>
            <BellRing aria-hidden="true" />
            Alerts and phone
          </Button>
        </div>
      </header>
      {body}
      {form !== undefined && (
        <ServiceForm
          {...(form.service === undefined ? {} : { service: form.service })}
          org={defaultOrg}
          onClose={() => setForm(undefined)}
        />
      )}
      {alerts && data !== undefined && (
        <AlertsSheet phone={data.phone} settings={data.settings} onClose={() => setAlerts(false)} />
      )}
    </div>
  );
}
