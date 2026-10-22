import {
  CLIENT_STATUS_LABEL,
  type ClientStatus,
  type IncidentView,
  REPORT_SECTION_LABEL,
  REPORT_SECTIONS,
  type ReportText,
  type Task,
} from "@majhi/shared";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { LampState } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useAnswerIncident, useAskCaptain, useEditReport, useSendReport } from "@/lib/incident-queries";
import { useTaskRow } from "@/lib/task-queries";
import { CloseDialog } from "../task/task-menu";
import { DockBar } from "./dock-bar";
import { Markdown } from "./markdown";

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

/** What an incident line needs from the paused task it takes in: why it stopped, the buttons that fix it, its details. */
export interface PauseView {
  why: string;
  actions: ReactNode;
  details: ReactNode;
  below: ReactNode;
}

/**
 * The incident as one line above the message box: its lamp, "Incident" or "Recovered", the stage it is at, Details
 * (what each client room sees, the four steps, the follow-ups) and its buttons. When the task is paused the line
 * takes the pause in: why the agent stopped, in one plain line, and the one set of buttons. One card, never a stack.
 */
export function IncidentLine({
  view,
  task,
  pause,
  working,
}: {
  view: IncidentView;
  task: Task | undefined;
  pause?: PauseView | undefined;
  /** An agent of the task is in its turn: "Let the lead continue" has nothing to continue. */
  working: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const ask = useAskCaptain();
  const answer = useAnswerIncident();
  const toast = useToast();
  const fail = (what: string) => (error: unknown) =>
    toast(what, { detail: describeError(error), tone: "error" });
  const asking = view.recovered !== undefined && !view.recovered.closed;
  const stage = view.steps.find((s) => s.status === view.status);
  const told = view.rooms.some((r) => r.toldAt !== undefined);
  const stageText = [
    `${CLIENT_STATUS_LABEL[view.status]}${stage?.at === undefined ? "" : ` ${clock(stage.at)}`}`,
    view.report?.internal.cause ? "cause found" : "cause not found",
    told ? "client told" : "client not told yet",
    view.quiet === undefined ? "" : `nobody has looked: ${view.quiet}`,
  ].filter((p) => p !== "");
  const title = asking ? "Recovered. Close it?" : view.recovered !== undefined ? "Recovered" : "Incident";
  const line = asking
    ? (pause?.why ?? "The watch is green and nothing was shipped. Close it, or let the lead keep working.")
    : [stageText.join(" · "), pause?.why].filter((p) => p !== undefined && p !== "").join(" · ");
  const open = task !== undefined && task.status !== "done";
  const close = asking ? (
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
      Close
    </Button>
  ) : open ? (
    <Button size="sm" onClick={() => setClosing(true)}>
      Close incident
    </Button>
  ) : undefined;
  return (
    <>
      {closing && task !== undefined && <CloseDialog task={task} onDone={() => setClosing(false)} />}
      <li className="list-none">
        <DockBar
          label="Incident"
          lamp={view.recovered === undefined ? LAMP[view.status] : "working"}
          title={title}
          line={line}
          inline={!asking}
          detailsLabel="Details"
          details={<IncidentDetails view={view} task={task} pause={pause} />}
          below={pause?.below}
          actions={
            <>
              {!asking && pause?.actions}
              {close}
              {asking && !working && (
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
              )}
              {view.quiet !== undefined && (
                <Button
                  size="sm"
                  disabled={ask.isPending}
                  onClick={() => ask.mutate(view.task, { onError: fail("Could not ask the captain") })}
                >
                  Ask the captain now
                </Button>
              )}
            </>
          }
        />
      </li>
    </>
  );
}

/** What Details opens: each client room with what it sees, the four steps, the follow-ups, and what a pause left. */
function IncidentDetails({
  view,
  task,
  pause,
}: {
  view: IncidentView;
  task: Task | undefined;
  pause: PauseView | undefined;
}) {
  const row = useTaskRow(task?.id);
  const followUps = row?.case?.followUps ?? [];
  const current = view.status;
  return (
    <>
      {view.facts !== "" && <p className="text-pretty">{view.facts}</p>}
      {view.rooms.map((room) => (
        <p key={room.room} className="text-pretty">
          <span className="font-medium">
            {room.joined === true
              ? `${room.title}: joined a newer incident`
              : `${room.title} sees ${room.sees === undefined ? "nothing yet" : CLIENT_STATUS_LABEL[room.sees]}`}
          </span>
          {room.joined === true ? "" : `. ${lineOf(view, room)}`}
        </p>
      ))}
      <Steps view={view} current={current} />
      {followUps.length > 0 && <FollowUps items={followUps} />}
      {pause?.details}
    </>
  );
}

/** The follow-ups the case found, folded behind one line, each as markdown. */
function FollowUps({ items }: { items: readonly { id: string; text: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-fit cursor-pointer text-sm font-medium text-fg hover:underline"
      >
        Follow-ups ({items.length}) {open ? "▾" : "▸"}
      </button>
      {open && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {items.map((f) => (
            <li key={f.id} className="min-w-0">
              <Markdown text={f.text} />
            </li>
          ))}
        </ul>
      )}
    </div>
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

function Steps({ view, current: status }: { view: IncidentView; current: ClientStatus }) {
  const current = view.steps.findIndex((s) => s.status === status);
  return (
    <ol className="m-0 flex list-none flex-wrap gap-x-4 gap-y-0.5 p-0 text-sm">
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

/** The report of a resolved incident, in its two versions, with the owner's Send to the client. */
export function IncidentReport({ view }: { view: IncidentView }) {
  return view.report === undefined ? null : (
    <li className="list-none">
      <Report view={view} report={view.report} />
    </li>
  );
}

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
