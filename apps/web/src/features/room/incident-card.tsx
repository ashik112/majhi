import {
  CLIENT_STATUS_LABEL,
  type ClientStatus,
  type IncidentView,
  REPORT_SECTION_LABEL,
  REPORT_SECTIONS,
  type ReportText,
  type Task,
} from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { LampState } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useAnswerIncident, useAskCaptain, useEditReport, useSendReport } from "@/lib/incident-queries";
import { CloseDialog } from "../task/task-menu";
import { DockBar } from "./dock-bar";

const LAMP: Record<ClientStatus, LampState> = {
  investigating: "needs",
  identified: "needs",
  monitoring: "working",
  resolved: "done",
};

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** The card shows while an incident is open, and stays once it has a report, frozen after it was sent. */
export function incidentCardOpen(view: IncidentView | null | undefined): view is IncidentView {
  if (view === null || view === undefined) return false;
  return view.status !== "resolved" || view.report !== undefined;
}

/**
 * What the client sees of an incident, as bars in the room's dock: one per client room with the four steps and the
 * time each began, and, once the incident is resolved, the report with an Internal and Client version. Sending it is
 * the owner's click; the text freezes once it went.
 */
export function IncidentCard({ view, task }: { view: IncidentView; task?: Task | undefined }) {
  const [closing, setClosing] = useState(false);
  const ask = useAskCaptain();
  const answer = useAnswerIncident();
  const toast = useToast();
  const fail = (what: string) => (error: unknown) =>
    toast(what, { detail: describeError(error), tone: "error" });
  const showStatus =
    (view.rooms.length === 0 || view.quiet !== undefined || view.recovered !== undefined) &&
    view.status !== "resolved";
  const closeButton =
    task === undefined || task.status === "done" ? undefined : (
      <Button size="sm" onClick={() => setClosing(true)}>
        Close incident
      </Button>
    );
  return (
    <>
      {closing && task !== undefined && <CloseDialog task={task} onDone={() => setClosing(false)} />}
      {showStatus && (
        <li className="list-none">
          <DockBar
            label="Incident"
            lamp={view.recovered === undefined ? LAMP[view.status] : "working"}
            title={view.recovered === undefined ? CLIENT_STATUS_LABEL[view.status] : "Recovered"}
            line={[view.facts, view.quiet === undefined ? "" : `Nobody has looked: ${view.quiet}`]
              .filter((p) => p !== "")
              .join(" · ")}
            actions={
              <>
                {closeButton}
                {view.quiet !== undefined && (
                  <Button
                    size="sm"
                    disabled={ask.isPending}
                    onClick={() => ask.mutate(view.task, { onError: fail("Could not ask the captain") })}
                  >
                    Ask the captain now
                  </Button>
                )}
                {view.recovered !== undefined && !view.recovered.closed && (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={answer.isPending}
                      onClick={() =>
                        answer.mutate(
                          { id: `iask:recovered:${view.task}`, option: "close" },
                          { onError: fail("Could not close the incident") },
                        )
                      }
                    >
                      Close: it recovered
                    </Button>
                    <Button
                      size="sm"
                      disabled={answer.isPending}
                      onClick={() =>
                        answer.mutate(
                          { id: `iask:recovered:${view.task}`, option: "continue" },
                          { onError: fail("Could not answer") },
                        )
                      }
                    >
                      Let the lead continue
                    </Button>
                  </>
                )}
              </>
            }
          />
        </li>
      )}
      {view.rooms.map((room, i) => (
        <li key={room.room} className="list-none">
          <DockBar
            label={`${room.title} sees`}
            lamp={room.joined === true ? "idle" : LAMP[room.sees ?? view.status]}
            title={
              room.joined === true
                ? `${room.title}: joined`
                : `${room.title} sees: ${room.sees === undefined ? "nothing yet" : CLIENT_STATUS_LABEL[room.sees]}`
            }
            line={
              room.joined === true
                ? "This chat follows a newer incident and hears about that one"
                : lineOf(view, room)
            }
            actions={i === 0 && !showStatus ? closeButton : undefined}
            below={
              i === 0 && room.joined !== true && view.status !== "resolved" ? (
                <Steps view={view} />
              ) : undefined
            }
          />
        </li>
      ))}
      {view.report !== undefined && (
        <li className="list-none">
          <Report view={view} report={view.report} />
        </li>
      )}
    </>
  );
}

function lineOf(view: IncidentView, room: IncidentView["rooms"][number]): string {
  const told =
    room.update === "held"
      ? "an update waits for you"
      : room.update === "failed"
        ? "the last update did not go"
        : room.toldAt === undefined
          ? "not told yet"
          : `told ${room.title} ${clock(room.toldAt)}`;
  return [view.facts, told].filter((p) => p !== "").join(" · ");
}

function Steps({ view }: { view: IncidentView }) {
  const current = view.steps.findIndex((s) => s.status === view.status);
  return (
    <ol className="m-0 mt-1 flex list-none flex-wrap gap-x-4 gap-y-0.5 p-0 pl-4 text-sm">
      {view.steps.map((step, i) => (
        <li
          key={step.status}
          className={cn(
            i < current && step.at !== undefined
              ? "text-fg-faint line-through"
              : i === current
                ? "font-medium text-fg"
                : "text-fg-faint",
          )}
        >
          {CLIENT_STATUS_LABEL[step.status]}
          {step.at === undefined ? "" : ` ${clock(step.at)}`}
        </li>
      ))}
    </ol>
  );
}

type Version = "internal" | "client";

function Report({ view, report }: { view: IncidentView; report: NonNullable<IncidentView["report"]> }) {
  const [version, setVersion] = useState<Version>("client");
  const [draft, setDraft] = useState<ReportText>();
  const edit = useEditReport();
  const send = useSendReport();
  const toast = useToast();
  const text = report[version];
  const frozen = report.sent.length > 0;
  const unsent = view.rooms.filter((r) => !report.sent.some((s) => s.room === r.room));
  const fail = (what: string) => (error: unknown) =>
    toast(what, { detail: describeError(error), tone: "error" });

  const save = () => {
    if (draft === undefined) return;
    edit.mutate(
      { task: view.task, version, text: draft },
      { onSuccess: () => setDraft(undefined), onError: fail("Could not save the report") },
    );
  };

  return (
    <DockBar
      label="Report"
      lamp={frozen && unsent.length === 0 ? "done" : view.rooms.length === 0 ? "idle" : "needs"}
      title={
        <span className="flex items-center gap-2">
          RCA
          <span className="inline-flex rounded-md border border-line-control bg-field p-0.5 text-sm font-normal">
            {(["internal", "client"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={version === v}
                onClick={() => {
                  setVersion(v);
                  setDraft(undefined);
                }}
                className={cn(
                  "cursor-pointer rounded px-2 py-0.5",
                  version === v ? "bg-selected text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                {v === "internal" ? "Internal" : "Client"}
              </button>
            ))}
          </span>
        </span>
      }
      line={
        frozen
          ? report.sent
              .map(
                (s) =>
                  `Sent to ${view.rooms.find((r) => r.room === s.room)?.title ?? "the chat"} at ${clock(s.at)}`,
              )
              .join(" · ")
          : report.warn
      }
      actions={
        draft === undefined ? (
          <>
            {!frozen && (
              <Button size="sm" onClick={() => setDraft({ ...text })}>
                Edit
              </Button>
            )}
            {version === "client" &&
              unsent.map((room) => (
                <Button
                  key={room.room}
                  size="sm"
                  variant="primary"
                  data-primary-action=""
                  disabled={send.isPending}
                  onClick={() =>
                    send.mutate(
                      { task: view.task, room: room.room },
                      { onError: fail("Could not send the report") },
                    )
                  }
                >
                  {`Send to ${room.title}`}
                </Button>
              ))}
          </>
        ) : (
          <>
            <Button size="sm" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={edit.isPending} onClick={save}>
              Save
            </Button>
          </>
        )
      }
      below={
        <dl
          className="m-0 grid gap-x-4 gap-y-1.5 pl-4 text-sm"
          style={{ gridTemplateColumns: "110px minmax(0,1fr)" }}
        >
          {REPORT_SECTIONS.map((section) => (
            <Section
              key={section}
              label={REPORT_SECTION_LABEL[section]}
              value={draft?.[section] ?? text[section]}
              editing={draft !== undefined}
              onChange={(value) => draft !== undefined && setDraft({ ...draft, [section]: value })}
            />
          ))}
        </dl>
      }
    />
  );
}

function Section({
  label,
  value,
  editing,
  onChange,
}: {
  label: string;
  value: string;
  editing: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <dt className="text-fg-faint">{label}</dt>
      <dd className="m-0 whitespace-pre-line text-fg-soft">
        {editing ? (
          <textarea
            aria-label={label}
            value={value}
            rows={2}
            maxLength={2000}
            onChange={(e) => onChange(e.target.value)}
            className="w-full resize-y rounded-md border border-line-control bg-field px-2 py-1 text-sm text-fg focus-visible:border-accent focus-visible:outline-none"
          />
        ) : (
          value
        )}
      </dd>
    </>
  );
}
