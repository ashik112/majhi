import type { OpsIncident, WatchDef, WatchFire, WatchFixId, WatchView } from "@majhi/shared";
import { PAGE_PATH } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Pause, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Lamp } from "@/components/ui/lamp";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useAnswerDecision } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import {
  useAckIncident,
  useCheckWatch,
  usePauseWatch,
  useRemoveWatch,
  useSaveWatch,
  useSnoozeWatch,
} from "@/lib/watch-queries";
import { ActionSection } from "./action-section";
import { Timeline } from "./detail";
import { HistoryChart } from "./history-chart";
import { STATUS_LAMP } from "./rows";

const NEEDS_WORD: Record<string, string> = {
  database: "database",
  cloud: "cloud",
  deploy: "deploy",
  ssh: "SSH",
  project: "a project",
  "service name": "a service name",
  "log folder": "a log folder",
  runbook: "a runbook",
};

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1", className)}>{children}</div>
  );
}

/** The limit the chart draws: the number the alert compares with. */
function limitOf(def: WatchDef): number | undefined {
  const c = def.condition;
  return c.type === "above" || c.type === "below" ? c.value : undefined;
}

/**
 * One watch: what it says now and for how long, the captain's finding and the question it waits on,
 * what happens when it fires (each part editable here), and how it checks.
 */
export function WatchDetail({
  watch,
  incident,
  now,
  workspace,
  phoneOn,
  onSetUpPhone,
  onEdit,
  onBack,
}: {
  watch: WatchView;
  incident: OpsIncident | undefined;
  now: number;
  workspace: string;
  /** Pushes to the phone go out: it is set up and switched on. */
  phoneOn: boolean;
  onSetUpPhone: () => void;
  onEdit: () => void;
  onBack: (() => void) | undefined;
}) {
  const save = useSaveWatch();
  const check = useCheckWatch();
  const pause = usePauseWatch();
  const snooze = useSnoozeWatch();
  const remove = useRemoveWatch();
  const answer = useAnswerDecision();
  const ack = useAckIncident();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const { def } = watch;
  const fire = def.fire;
  const alerting = watch.status === "alerting" || watch.status === "changed";
  const lamp = STATUS_LAMP[watch.status];
  const failed = (title: string) => (e: unknown) => toast(title, { detail: describeError(e), tone: "error" });

  const setFire = (patch: Partial<WatchFire>) =>
    save.mutate(
      { id: watch.id, org: watch.org, def: { ...def, fire: { ...fire, ...patch } } },
      { onError: failed("Could not save it") },
    );
  const setFix = (patch: Partial<WatchFire["fix"]>) => setFire({ fix: { ...fire.fix, ...patch } });
  const toggleFix = (id: WatchFixId) =>
    setFix({
      allowed: fire.fix.allowed.includes(id)
        ? fire.fix.allowed.filter((x) => x !== id)
        : [...fire.fix.allowed, id],
    });
  const [orDo, setOrDo] = useState(fire.orDo ?? "");
  const [rerun, setRerun] = useState(String(fire.fix.rerunMin));

  const headWord = alerting
    ? `${watch.word}${watch.since === undefined ? "" : ` since ${clock(watch.since)}`}`
    : watch.word;
  const numberKind = watch.samples24.some((s) => s.v !== null) || watch.samples90.some((s) => s.v !== null);
  const isPrice = def.spec.kind === "price";
  const needsAck = incident !== undefined && incident.status === "open" && incident.ackedAt === undefined;
  const question = watch.question;
  const quiet = watch.quietUntil !== undefined;
  const wsLabel = (
    <span className="truncate rounded-md border border-line px-1.5 text-xs text-fg-soft">{workspace}</span>
  );

  return (
    <DetailPane
      label={`Watch ${def.name}`}
      head={
        <div className="flex min-w-0 flex-col gap-1">
          {onBack !== undefined && (
            <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-1 self-start">
              <ArrowLeft aria-hidden="true" />
              Watch
            </Button>
          )}
          <div className="flex min-w-0 items-center gap-x-3">
            <Lamp state={lamp} size={8} />
            <span className={cn("shrink-0 text-sm font-semibold", alerting ? "text-red" : "text-fg-muted")}>
              {headWord}
            </span>
            {wsLabel}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onEdit}>
              <Pencil aria-hidden="true" />
              Edit
            </Button>
          </div>
          <h2 className="m-0 truncate text-md font-semibold text-fg" title={def.name}>
            {def.name}
          </h2>
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-3 pt-4 pb-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="tnum min-w-0 truncate font-mono text-xl text-fg">{watch.value}</span>
          {watch.stat !== undefined && <span className="text-sm text-lamp-done">{watch.stat}</span>}
          {watch.paused !== undefined && <span className="text-sm text-fg-faint">{watch.paused.why}</span>}
          {watch.unavailable !== undefined && (
            <span className="text-sm text-fg-faint">Could not read it: {watch.unavailable}</span>
          )}
        </div>
        {numberKind && (
          <HistoryChart
            day={watch.samples24}
            quarter={watch.samples90}
            threshold={limitOf(def)}
            caption={
              isPrice ? "Price" : def.spec.kind === "database" && def.spec.label ? def.spec.label : "Value"
            }
            now={now}
            longRange={isPrice}
          />
        )}
        {(watch.found !== undefined || question !== undefined || needsAck) && (
          <div className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-raised px-3 py-2.5">
            {watch.found !== undefined && (
              <p className="m-0 text-base text-fg-soft text-pretty">
                <span className="text-fg-faint">The captain found: </span>
                {watch.found}
              </p>
            )}
            {question !== undefined && (
              <p className="m-0 text-base font-medium text-fg text-pretty">{question.text}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {question?.options.map((o) => (
                <Button
                  key={o.id}
                  size="sm"
                  variant={o.primary === true ? "primary" : "secondary"}
                  disabled={answer.isPending}
                  onClick={() =>
                    answer.mutate(
                      { id: question.decision, option: o.id },
                      { onError: failed("Could not send your answer") },
                    )
                  }
                >
                  {o.label}
                </Button>
              ))}
              {question === undefined && needsAck && incident !== undefined && (
                <Button
                  size="sm"
                  variant={watch.link === undefined ? "primary" : "secondary"}
                  disabled={ack.isPending}
                  onClick={() => ack.mutate(incident.id, { onError: failed("Could not acknowledge it") })}
                >
                  {isPrice ? "Got it" : "Acknowledge"}
                </Button>
              )}
              {watch.link !== undefined && (
                <Button size="sm" variant="primary" asChild>
                  <a href={watch.link.url} target="_blank" rel="noopener noreferrer">
                    Open {watch.link.label}
                    <ExternalLink aria-hidden="true" />
                  </a>
                </Button>
              )}
              {isPrice && alerting && (
                <Button
                  size="sm"
                  onClick={() =>
                    pause.mutate({ id: watch.id, paused: true }, { onError: failed("Could not pause it") })
                  }
                >
                  Pause watching
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <DetailSection title="When it fires">
        <Row>
          <Switch
            label="Alert me"
            checked={fire.alert.on}
            onChange={(on) => setFire({ alert: { ...fire.alert, on } })}
          />
          {fire.alert.on && (
            <Switch
              label="Phone alert"
              checked={fire.alert.phone}
              onChange={(phone) => setFire({ alert: { ...fire.alert, phone } })}
            />
          )}
          {fire.alert.on && fire.alert.phone && !phoneOn && (
            <>
              <span className="text-sm text-amber">No phone is set up, so nothing reaches it.</span>
              <Button size="sm" onClick={onSetUpPhone}>
                Set up phone
              </Button>
            </>
          )}
        </Row>
        <Switch
          label={isPrice ? "Compare other stores" : "Captain looks into it"}
          checked={fire.investigate}
          onChange={(investigate) => setFire({ investigate })}
        />
        {def.spec.kind === "price" && def.spec.compare.length > 0 && (
          <p className="m-0 text-sm text-fg-faint">
            Compares with {def.spec.compare.map((u) => new URL(u).hostname.replace(/^www\./, "")).join(", ")}.
          </p>
        )}
        {watch.fixes.length > 0 && (
          <div className="flex min-w-0 flex-col gap-2">
            <Row>
              <span className="text-base text-fg-soft">Fix it</span>
              <Segmented
                label="Fix it"
                value={fire.fix.mode}
                onChange={(mode) => setFix({ mode })}
                segments={[
                  { value: "off", label: "Off" },
                  { value: "ask", label: "Ask me first" },
                  { value: "auto", label: "Do it, then tell me" },
                ]}
              />
            </Row>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-fg-soft">
              {watch.fixes.map((f) => (
                <li key={f.id} className="flex min-w-0 items-baseline gap-2">
                  {f.state === "needs" ? (
                    <>
                      <span aria-hidden="true" className="text-fg-faint">
                        ✕
                      </span>
                      <span className="min-w-0 flex-1 text-fg-faint">
                        {f.label}: needs {NEEDS_WORD[f.need ?? ""] ?? f.need} access
                        {f.need === "database" ||
                        f.need === "ssh" ||
                        f.need === "cloud" ||
                        f.need === "deploy" ? (
                          <>
                            {" "}
                            <Link
                              to={PAGE_PATH.connections}
                              search={{}}
                              className="text-accent-text underline-offset-2 hover:underline"
                            >
                              Connect
                            </Link>
                          </>
                        ) : null}
                      </span>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-pressed={f.state === "on"}
                      onClick={() => toggleFix(f.id)}
                      className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 text-left"
                    >
                      <span
                        aria-hidden="true"
                        className={f.state === "on" ? "text-lamp-done" : "text-fg-faint"}
                      >
                        {f.state === "on" ? "✓" : "○"}
                      </span>
                      <span className={cn("min-w-0 flex-1", f.state === "off" && "text-fg-muted")}>
                        {f.label} <span className="text-fg-faint">· {f.detail}</span>
                      </span>
                    </button>
                  )}
                </li>
              ))}
              <li className="text-fg-faint">Never: drop, delete or truncate data</li>
            </ul>
            <Row className="text-sm text-fg-soft">
              <span>Then rerun the check. Not fixed in</span>
              <Input
                aria-label="Minutes before it pages you"
                inputMode="numeric"
                className="h-7 w-14 text-center font-mono"
                value={rerun}
                onChange={(e) => setRerun(e.target.value)}
                onBlur={() => {
                  const n = Number(rerun);
                  if (Number.isInteger(n) && n >= 1 && n <= 240 && n !== fire.fix.rerunMin)
                    setFix({ rerunMin: n });
                  else setRerun(String(fire.fix.rerunMin));
                }}
              />
              <span>min or worse: undo what it can and page me.</span>
            </Row>
          </div>
        )}
        {!isPrice && (
          <Switch
            label="Draft a status note, which waits in Needs you"
            checked={fire.statusNote}
            onChange={(statusNote) => setFire({ statusNote })}
          />
        )}
        <Row>
          <span className="shrink-0 text-base text-fg-soft">Or do this</span>
          <Input
            aria-label="Or do this"
            className="min-w-0 flex-1"
            placeholder={isPrice ? "e.g. post it in my Private chat" : "e.g. tell the on-call channel"}
            value={orDo}
            onChange={(e) => setOrDo(e.target.value)}
            onBlur={() => {
              const next = orDo.trim();
              if (next !== (fire.orDo ?? "")) {
                const { orDo: _old, ...rest } = fire;
                save.mutate(
                  {
                    id: watch.id,
                    org: watch.org,
                    def: { ...def, fire: next === "" ? rest : { ...rest, orDo: next } },
                  },
                  { onError: failed("Could not save it") },
                );
              }
            }}
          />
        </Row>
        {isPrice && <p className="m-0 text-sm text-fg-faint">Never buys. Purchases stay yours.</p>}
        <ActionSection watch={watch} now={now} />
        <h4 className="m-0 mt-1 text-sm font-semibold text-fg">When it recovers</h4>
        <Switch
          label="Tell me and close the incident with how long it lasted"
          checked={fire.tellOnRecover}
          onChange={(tellOnRecover) => setFire({ tellOnRecover })}
        />
        <Row>
          <span className="text-base text-fg-soft">
            {quiet
              ? `${watch.quietKind === "maintenance" ? "Maintenance" : "Snoozed"} until ${clock(watch.quietUntil ?? "")}`
              : "Snooze or maintenance window"}
          </span>
          {quiet ? (
            <Button
              size="sm"
              onClick={() =>
                snooze.mutate(
                  { id: watch.id, minutes: 0, kind: "snooze" },
                  { onError: failed("Could not clear it") },
                )
              }
            >
              Clear
            </Button>
          ) : (
            <>
              {[
                { label: "1 h", minutes: 60, kind: "snooze" as const },
                { label: "8 h", minutes: 480, kind: "snooze" as const },
                { label: "Maintenance 2 h", minutes: 120, kind: "maintenance" as const },
              ].map((o) => (
                <Button
                  key={o.label}
                  size="sm"
                  onClick={() =>
                    snooze.mutate(
                      { id: watch.id, minutes: o.minutes, kind: o.kind },
                      { onError: failed("Could not snooze it") },
                    )
                  }
                >
                  {o.label}
                </Button>
              ))}
            </>
          )}
        </Row>
      </DetailSection>

      {incident !== undefined && incident.status === "open" && (
        <DetailSection title="What happened" note="Times are yours">
          <Timeline incident={incident} now={now} />
        </DetailSection>
      )}

      <DetailSection
        title="How it checks"
        actions={
          <>
            <Button
              size="sm"
              disabled={check.isPending}
              onClick={() => check.mutate(watch.id, { onError: failed("Could not check it") })}
            >
              <RefreshCw aria-hidden="true" className={check.isPending ? "animate-spin" : undefined} />
              Check now
            </Button>
            <Button
              size="sm"
              onClick={() =>
                pause.mutate(
                  { id: watch.id, paused: watch.status !== "paused" || quiet },
                  { onError: failed("Could not change it") },
                )
              }
            >
              {watch.status === "paused" && !quiet ? (
                <Play aria-hidden="true" />
              ) : (
                <Pause aria-hidden="true" />
              )}
              {watch.status === "paused" && !quiet ? "Resume" : "Pause"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Stop watching ${def.name}`}
              onClick={() => setConfirm(true)}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm text-fg-soft text-pretty break-words">{watch.how}</p>
      </DetailSection>
      {confirm && (
        <ConfirmDialog
          title={`Stop watching ${def.name}?`}
          body="Its history is deleted. An open incident is resolved."
          confirmLabel="Stop watching"
          busy={remove.isPending}
          onCancel={() => setConfirm(false)}
          onConfirm={() =>
            remove.mutate(watch.id, {
              onSuccess: () => setConfirm(false),
              onError: failed("Could not stop watching it"),
            })
          }
        />
      )}
    </DetailPane>
  );
}
