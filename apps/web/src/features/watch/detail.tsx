import { OPS_IMPACT_LABEL, type OpsIncident, type OpsServiceView } from "@majhi/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Pencil, RefreshCw, Trash2, Wrench } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Lamp } from "@/components/ui/lamp";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useFixCheck } from "@/lib/ops-queries";
import { PAGE_PATH } from "@/lib/pages";
import { useAckIncident, useCheckNow, useRemoveService } from "@/lib/watch-queries";
import {
  CHECK_LAMP,
  CHECK_WORD,
  incidentLamp,
  incidentWord,
  KIND_LABEL,
  spanText,
  TIMELINE_LABEL,
} from "./model";
import { Sparkline } from "./sparkline";

const SEVERITY_TONE = { high: "red", medium: "amber", low: "neutral" } as const;

/** What happened, in order: when, what kind of line, and the words. */
export function Timeline({ incident, now }: { incident: OpsIncident; now: number }) {
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {incident.timeline.map((t, i) => (
        <li
          // The same text can repeat at the same time, so the position is part of the key.
          // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log
          key={`${t.at}-${i}`}
          className="flex min-w-0 items-baseline gap-3 border-t border-line py-1.5 first:border-t-0"
        >
          <span
            className="tnum w-[72px] shrink-0 font-mono text-xs whitespace-nowrap text-fg-faint"
            title={t.at}
          >
            {new Date(t.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </span>
          <span className="w-[104px] shrink-0 text-xs text-fg-muted">{TIMELINE_LABEL[t.kind]}</span>
          <span className="min-w-0 flex-1 text-sm text-fg-soft text-pretty break-words">{t.text}</span>
        </li>
      ))}
      <li className="border-t border-line pt-1.5 text-xs text-fg-faint">
        {incident.status === "resolved" && incident.resolvedAt !== undefined
          ? `Open for ${spanText(incident.openedAt, Date.parse(incident.resolvedAt))}`
          : `Open for ${spanText(incident.openedAt, now)}`}
        {incident.flaps > 0 && `, came back ${incident.flaps} ${incident.flaps === 1 ? "time" : "times"}`}
      </li>
    </ol>
  );
}

function BackButton({ onBack }: { onBack: (() => void) | undefined }) {
  if (onBack === undefined) return null;
  return (
    <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-1 self-start">
      <ArrowLeft aria-hidden="true" />
      Watch
    </Button>
  );
}

/** One incident: its state, the one click that matters (Acknowledge, or the Fix from Health), and its timeline. */
export function IncidentDetail({
  incident,
  now,
  workspace,
  onBack,
}: {
  incident: OpsIncident;
  now: number;
  workspace: string;
  onBack: (() => void) | undefined;
}) {
  const ack = useAckIncident();
  const fix = useFixCheck();
  const toast = useToast();
  const navigate = useNavigate();
  const open = incident.status === "open";
  const runFix = () => {
    if (incident.fix === undefined) return;
    fix.mutate(incident.fix.check, {
      onSuccess: (out) => {
        if (out.open !== undefined) {
          toast("Finish it in Health", { detail: out.detail });
          void navigate({ to: PAGE_PATH.usage, search: {} });
        } else
          toast(out.ok ? "Done" : "It did not work", {
            detail: out.detail,
            ...(out.ok ? {} : { tone: "error" as const }),
          });
      },
      onError: (e) => toast("Could not run the fix", { detail: describeError(e), tone: "error" }),
    });
  };
  return (
    <DetailPane
      label="Incident"
      head={
        <div className="flex min-w-0 flex-col gap-1">
          <BackButton onBack={onBack} />
          <div className="flex min-w-0 items-center gap-x-3">
            <Lamp state={incidentLamp(incident)} size={9} />
            <h2 className="m-0 min-w-0 truncate text-md font-semibold text-fg">{incident.title}</h2>
            <Badge tone={SEVERITY_TONE[incident.severity]}>{incident.severity}</Badge>
            <span className="shrink-0 text-sm whitespace-nowrap text-fg-muted">{incidentWord(incident)}</span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {open && incident.fix !== undefined && (
                <Button disabled={fix.isPending} onClick={runFix}>
                  <Wrench aria-hidden="true" />
                  {incident.fix.label}
                </Button>
              )}
              {open && incident.ackedAt === undefined && incident.severity === "high" && (
                <Button
                  variant="primary"
                  disabled={ack.isPending}
                  onClick={() =>
                    ack.mutate(incident.id, {
                      onError: (e) =>
                        toast("Could not acknowledge it", { detail: describeError(e), tone: "error" }),
                    })
                  }
                >
                  Acknowledge
                </Button>
              )}
            </div>
          </div>
          <p className="m-0 text-sm text-fg-faint">
            {workspace} · opened {formatAgo(incident.openedAt, now)}
            {incident.escalatedAt !== undefined && open && incident.ackedAt === undefined
              ? " · alerted twice, nobody acknowledged it"
              : ""}
          </p>
        </div>
      }
    >
      <DetailSection title="Timeline" note="Times are yours">
        <Timeline incident={incident} now={now} />
      </DetailSection>
      {incident.finding !== undefined && (
        <DetailSection title="The captain">
          <p className="m-0 text-base text-fg-soft text-pretty">
            The captain was woken with the evidence. It may read logs, propose a fix task and draft a status
            update; what it does is on the timeline.{" "}
            <Link
              to={PAGE_PATH.captain}
              search={{}}
              className="text-accent-text underline-offset-2 hover:underline"
            >
              Open the Captain
            </Link>
          </p>
        </DetailSection>
      )}
    </DetailPane>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-fg-faint">{label}</dt>
      <dd className="m-0 min-w-0 text-base text-fg-soft text-pretty break-words">{children}</dd>
    </div>
  );
}

/** One watched service: how it is now, 24 hours of latency, its open incident, what counts as up, and the past. */
export function ServiceDetail({
  service,
  incident,
  past,
  now,
  workspace,
  onEdit,
  onBack,
}: {
  service: OpsServiceView;
  incident: OpsIncident | undefined;
  past: OpsIncident[];
  now: number;
  workspace: string;
  onEdit: () => void;
  onBack: (() => void) | undefined;
}) {
  const check = useCheckNow();
  const remove = useRemoveService();
  const ack = useAckIncident();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const { def } = service;
  return (
    <DetailPane
      label={`Service ${def.name}`}
      head={
        <div className="flex min-w-0 flex-col gap-1">
          <BackButton onBack={onBack} />
          <div className="flex min-w-0 items-center gap-x-3">
            <Lamp state={CHECK_LAMP[service.status]} size={9} />
            <h2 className="m-0 min-w-0 truncate text-md font-semibold text-fg">{def.name}</h2>
            <span className="shrink-0 text-sm whitespace-nowrap text-fg-muted">
              {CHECK_WORD[service.status]}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button
                disabled={check.isPending}
                onClick={() =>
                  check.mutate(service.id, {
                    onError: (e) => toast("Could not check it", { detail: describeError(e), tone: "error" }),
                  })
                }
              >
                <RefreshCw aria-hidden="true" className={check.isPending ? "animate-spin" : undefined} />
                Check now
              </Button>
              <Button onClick={onEdit}>
                <Pencil aria-hidden="true" />
                Edit
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Stop watching ${def.name}`}
                onClick={() => setConfirm(true)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </div>
          <p className="m-0 truncate font-mono text-xs text-fg-faint" title={def.url}>
            {def.url}
          </p>
        </div>
      }
    >
      {incident !== undefined && (
        <DetailSection
          title="Incident"
          note={`${incidentWord(incident)}, ${incident.severity}`}
          actions={
            incident.ackedAt === undefined && incident.severity === "high" ? (
              <Button
                size="sm"
                variant="primary"
                disabled={ack.isPending}
                onClick={() =>
                  ack.mutate(incident.id, {
                    onError: (e) =>
                      toast("Could not acknowledge it", { detail: describeError(e), tone: "error" }),
                  })
                }
              >
                Acknowledge
              </Button>
            ) : undefined
          }
        >
          <Timeline incident={incident} now={now} />
        </DetailSection>
      )}
      <DetailSection title="Right now">
        <ul className="m-0 flex list-none flex-col p-0">
          {service.checks.length === 0 && (
            <li className="text-sm text-fg-faint">Not checked yet. The first look runs within 5 minutes.</li>
          )}
          {service.checks.map((c) => (
            <li
              key={c.kind}
              className="flex min-w-0 items-baseline gap-3 border-t border-line py-1.5 first:border-t-0"
            >
              <span className="w-[88px] shrink-0 text-sm text-fg-muted">{KIND_LABEL[c.kind]}</span>
              <span className="flex w-[104px] shrink-0 items-center gap-2 text-sm text-fg-soft">
                <Lamp state={CHECK_LAMP[c.status]} size={7} />
                {CHECK_WORD[c.status]}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg-soft" title={c.detail}>
                {c.detail}
              </span>
              {c.at !== undefined && (
                <span className="tnum shrink-0 font-mono text-xs text-fg-faint">{formatAgo(c.at, now)}</span>
              )}
            </li>
          ))}
        </ul>
      </DetailSection>
      <DetailSection
        title="Last 24 hours"
        note={service.uptime === undefined ? undefined : `${service.uptime}% of checks answered`}
      >
        <Sparkline samples={service.samples} now={now} />
      </DetailSection>
      <DetailSection title="What counts as up">
        <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-3 @[560px]:grid-cols-2">
          <Fact label="Workspace">{workspace}</Fact>
          <Fact label="Status">
            {def.expectStatus === undefined ? "Anything below 400" : `Exactly ${def.expectStatus}`}
          </Fact>
          <Fact label="Page contains">
            {def.keyword === undefined ? "Not checked" : <span className="font-mono">{def.keyword}</span>}
          </Fact>
          <Fact label="Slower than">
            {def.maxLatencyMs === undefined ? "No limit" : `${def.maxLatencyMs} ms`}
          </Fact>
          <Fact label="Certificate and name">
            {[def.tls ? "Certificate watched" : undefined, def.dns ? "Name lookup watched" : undefined]
              .filter(Boolean)
              .join(", ") || "Not watched"}
          </Fact>
          <Fact label="When it is down">{OPS_IMPACT_LABEL[def.impact]}</Fact>
          <Fact label="A fix opens in">
            {def.project === undefined ? "No project" : <span className="font-mono">{def.project}</span>}
          </Fact>
          <Fact label="Monitor">
            {def.monitor === undefined ? (
              "None"
            ) : (
              <>
                <span className="font-mono">{def.monitor.tool}</span>, failing above {def.monitor.max}
              </>
            )}
          </Fact>
        </dl>
      </DetailSection>
      {past.length > 0 && (
        <DetailSection title="Past incidents">
          <ul className="m-0 flex list-none flex-col p-0">
            {past.map((p) => (
              <li
                key={p.id}
                className="flex min-w-0 items-baseline gap-3 border-t border-line py-1.5 first:border-t-0"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-fg-soft">{p.title}</span>
                <span className="tnum shrink-0 font-mono text-xs text-fg-faint">
                  {p.resolvedAt === undefined
                    ? ""
                    : `${spanText(p.openedAt, Date.parse(p.resolvedAt))}, ${formatAgo(p.resolvedAt, now)}`}
                </span>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Stop watching ${def.name}?`}
          body="Its checks and history are deleted. An open incident is resolved."
          confirmLabel="Stop watching"
          busy={remove.isPending}
          onCancel={() => setConfirm(false)}
          onConfirm={() =>
            remove.mutate(service.id, {
              onSuccess: () => setConfirm(false),
              onError: (e) =>
                toast("Could not stop watching it", { detail: describeError(e), tone: "error" }),
            })
          }
        />
      )}
    </DetailPane>
  );
}
