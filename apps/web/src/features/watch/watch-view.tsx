import { type OpsIncident, type OpsServiceView, PRIVATE } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BellRing, Plus, Radar } from "lucide-react";
import { useMemo, useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { DetailPane, ListDetail, ListPane, ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import { useWatch } from "@/lib/watch-queries";
import type { AppSearch } from "@/router";
import { AlertsSheet } from "./alerts-sheet";
import { IncidentDetail, ServiceDetail } from "./detail";
import { byWorkspace, CHECK_LAMP, CHECK_WORD, incidentLamp, incidentWord, spanText, summary } from "./model";
import { ServiceForm } from "./service-form";

const incidentId = (n: number) => `inc-${n}`;

function GroupHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-1.5 pb-1">
      <h2 className="m-0 truncate text-sm font-semibold text-fg">{children}</h2>
    </div>
  );
}

function IncidentRow({
  incident,
  selected,
  now,
  workspace,
  onSelect,
}: {
  incident: OpsIncident;
  selected: boolean;
  now: number;
  workspace: string;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-incident={incident.id}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(ROW, "flex-col gap-1 px-2.5 py-2", selected && ROW_SELECTED)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Lamp state={incidentLamp(incident)} size={7} />
          <span className="min-w-0 flex-1 truncate text-base text-fg" title={incident.title}>
            {incident.title}
          </span>
          <span className="shrink-0 text-xs text-fg-faint">{incidentWord(incident)}</span>
        </span>
        <span className="min-w-0 truncate pl-[15px] text-xs text-fg-faint">
          {workspace} ·{" "}
          {incident.status === "open"
            ? `open ${spanText(incident.openedAt, now)}`
            : `resolved ${formatAgo(incident.resolvedAt ?? incident.openedAt, now)}`}
        </span>
      </button>
    </li>
  );
}

function ServiceRow({
  service,
  selected,
  onSelect,
}: {
  service: OpsServiceView;
  selected: boolean;
  onSelect: () => void;
}) {
  const worst = service.checks.find((c) => c.status === service.status);
  return (
    <li>
      <button
        type="button"
        data-service={service.id}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(ROW, "flex-col gap-1 px-2.5 py-2", selected && ROW_SELECTED)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Lamp state={CHECK_LAMP[service.status]} size={7} />
          <span className="min-w-0 flex-1 truncate text-base text-fg" title={service.def.name}>
            {service.def.name}
          </span>
          <span className="shrink-0 text-xs text-fg-faint">{CHECK_WORD[service.status]}</span>
        </span>
        <span
          className="min-w-0 truncate pl-[15px] font-mono text-xs text-fg-faint"
          title={worst?.detail ?? service.def.url}
        >
          {service.status === "up" || worst === undefined
            ? `${service.uptime === undefined ? "" : `${service.uptime}% · `}${service.def.url.replace(/^https?:\/\//, "")}`
            : worst.detail}
        </span>
      </button>
    </li>
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
  const services = (data?.services ?? []).filter((s) => filter === undefined || s.org === filter);
  const incidents = (data?.incidents ?? []).filter((i) => filter === undefined || i.org === filter);
  const open = incidents.filter((i) => i.status === "open");
  const recent = incidents.filter((i) => i.status === "resolved").slice(0, 8);
  const groups = useMemo(() => byWorkspace(services), [services]);

  const wanted = search.id;
  const first = open[0] === undefined ? undefined : incidentId(open[0].id);
  const effective = wanted ?? (narrow ? undefined : (first ?? groups[0]?.services[0]?.id));
  const shownService = services.find((s) => s.id === effective);
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
  } else if (services.length === 0 && incidents.length === 0) {
    body = (
      <DetailPane label="Watch">
        <div className="flex flex-col items-start gap-3 pt-6">
          <h2 className="m-0 text-md font-semibold text-fg">Nothing is watched yet</h2>
          <p className="m-0 max-w-[560px] text-base text-fg-soft text-pretty">
            List a service and majhi checks it every 5 minutes: the address, how fast it answers, its
            certificate and its name. When it stays down, majhi opens an incident, wakes the captain with the
            evidence and alerts you. majhi also watches itself: a full disk or a stuck queue shows up here as
            an incident in Private.
          </p>
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
      <ListPane
        label="Watched services and incidents"
        className="w-[340px] min-[1320px]:w-[380px] max-[999px]:w-full"
        footer={
          <Button className="w-full" onClick={() => setForm({})}>
            <Plus aria-hidden="true" />
            Watch a service
          </Button>
        }
      >
        {(open.length > 0 || recent.length > 0) && (
          <section aria-label="Incidents" className="mb-3">
            <GroupHead>Incidents</GroupHead>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {[...open, ...recent].map((i) => (
                <IncidentRow
                  key={i.id}
                  incident={i}
                  selected={incidentId(i.id) === effective}
                  now={now}
                  workspace={nameOf(i.org)}
                  onSelect={() => select(incidentId(i.id))}
                />
              ))}
            </ul>
          </section>
        )}
        {groups.map((g) => (
          <section key={g.org} aria-label={`${nameOf(g.org)} services`} className="mb-3">
            <GroupHead>{nameOf(g.org)}</GroupHead>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {g.services.map((s) => (
                <ServiceRow
                  key={s.id}
                  service={s}
                  selected={s.id === effective}
                  onSelect={() => select(s.id)}
                />
              ))}
            </ul>
          </section>
        ))}
        {services.length === 0 && (
          <p className="m-0 px-2.5 text-sm text-fg-faint text-pretty">
            No service is watched in this workspace.
          </p>
        )}
      </ListPane>
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
      <ListDetail>
        {narrow ? (pane ?? list) : list}
        {!narrow && pane}
      </ListDetail>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Watch"
        subtitle={
          data === undefined ? "Services you list are checked for you" : summary(services, open.length)
        }
      >
        <Button onClick={() => setAlerts(true)}>
          <BellRing aria-hidden="true" />
          Alerts and phone
        </Button>
      </PageHeader>
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
