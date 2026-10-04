import {
  DEADLINE_KIND_LABEL,
  DEADLINE_KINDS,
  DEADLINE_STATE_LABEL,
  type Deadline,
  type DeadlineKind,
  type DeadlineState,
} from "@majhi/shared";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChipsInput } from "@/components/ui/chips-input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { DetailPane } from "@/components/ui/list-detail";
import { Segmented } from "@/components/ui/segmented";
import { Select, Textarea } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useBusinessCommand, useCrmList, useDeadlines } from "@/lib/business-queries";
import { describeError } from "@/lib/errors";
import {
  EmptyState,
  ErrorLine,
  inScope,
  ListShell,
  Meta,
  RowFrame,
  type Scope,
  ScopeFilter,
  ScopeTag,
  scopeLabel,
  VirtualRows,
} from "./parts";

const STATE_LAMP: Record<DeadlineState, LampState> = {
  overdue: "needs",
  today: "needs",
  soon: "paused",
  later: "idle",
  closed: "done",
};

/** "in 12 days", "today", "3 days ago". */
export function whenWord(d: Pick<Deadline, "daysLeft" | "state">): string {
  if (d.state === "closed") return "closed";
  if (d.daysLeft === 0) return d.state === "overdue" ? "just passed" : "today";
  const n = Math.abs(d.daysLeft);
  const unit = n === 1 ? "day" : "days";
  return d.daysLeft > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}

function zones(): string[] {
  const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  return fn ? fn("timeZone") : ["UTC"];
}
const MACHINE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function fullDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

export function DeadlinesPane({ scopes }: { scopes: readonly Scope[] }) {
  const list = useDeadlines();
  const [scope, setScope] = useState("*");
  const [kind, setKind] = useState<"" | DeadlineKind>("");
  const [view, setView] = useState<"open" | "closed">("open");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number>();
  const [mode, setMode] = useState<"view" | "edit" | "new">("view");

  const all = list.data?.deadlines ?? [];
  const open = all.filter((d) => d.status === "open");
  const late = open.filter((d) => d.state === "overdue").length;
  const rows = useMemo(() => {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== "");
    return all.filter(
      (d) =>
        (view === "open" ? d.status === "open" : d.status !== "open") &&
        inScope(scope, d.org) &&
        (kind === "" || d.kind === kind) &&
        words.every((w) => `${d.title} ${d.notes} ${DEADLINE_KIND_LABEL[d.kind]}`.toLowerCase().includes(w)),
    );
  }, [all, view, scope, kind, query]);

  const select = useCallback((id: string | number) => {
    setSelected(Number(id));
    setMode((m) => (m === "new" ? m : "view"));
  }, []);
  const getId = useCallback((d: Deadline) => d.id, []);

  return (
    <>
      <ListShell
        label="Deadlines"
        search={query}
        onSearch={setQuery}
        placeholder="Search deadlines"
        filters={
          <>
            <ScopeFilter value={scope} onChange={setScope} scopes={scopes} />
            <Select
              aria-label="Kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as "" | DeadlineKind)}
              className="h-8 w-[112px] text-sm"
            >
              <option value="">All kinds</option>
              {DEADLINE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DEADLINE_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </>
        }
        footer={
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Segmented
                label="Show deadlines"
                value={view}
                segments={[
                  { value: "open", label: "Open", count: open.length },
                  { value: "closed", label: "Closed" },
                ]}
                onChange={(v) => {
                  setView(v);
                  setSelected(undefined);
                }}
                className="[&_button]:h-7"
              />
              {late > 0 && view === "open" && (
                <span className="tnum ml-auto font-mono text-xs text-lamp-needs">{late} overdue</span>
              )}
            </div>
            <Button variant="primary" className="w-full" onClick={() => setMode("new")}>
              New deadline <Kbd>n</Kbd>
            </Button>
          </div>
        }
      >
        {list.isError ? (
          <div className="p-3">
            <ErrorLine>Could not load deadlines: {describeError(list.error)}</ErrorLine>
          </div>
        ) : list.data === undefined ? (
          <div className="p-2">
            <RowsSkeleton rows={6} height={48} />
          </div>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-fg-faint text-pretty">
            {all.length === 0 ? "Nothing is due." : "Nothing matches. Clear the search or the filters."}
          </p>
        ) : (
          <VirtualRows
            label="Deadlines"
            items={rows}
            getId={getId}
            selectedId={selected}
            onSelect={select}
            estimate={54}
            row={(d, on) => (
              <RowFrame selected={on}>
                <div className="flex min-w-0 items-center gap-2">
                  <Lamp state={STATE_LAMP[d.state]} size={7} />
                  <span className="min-w-0 flex-1 truncate text-base text-fg" title={d.title}>
                    {d.title}
                  </span>
                  <Meta className={d.state === "overdue" ? "text-red" : undefined}>{whenWord(d)}</Meta>
                </div>
                <div className="flex min-w-0 items-baseline gap-2 pl-[15px] text-xs text-fg-faint">
                  <span className="shrink-0">{DEADLINE_KIND_LABEL[d.kind]}</span>
                  <Meta>{d.due.replace("T", " ")}</Meta>
                  <span className="min-w-0 flex-1" />
                  <ScopeTag label={scopeLabel(scopes, d.org)} business={d.org === undefined} />
                </div>
              </RowFrame>
            )}
            onKey={(e) => {
              if (e.key === "n") {
                e.preventDefault();
                setMode("new");
              } else if (e.key === "e" && selected !== undefined) {
                e.preventDefault();
                setMode("edit");
              }
            }}
          />
        )}
      </ListShell>
      {mode === "new" ? (
        <DetailPane label="New deadline" head={<h2 className="text-md font-semibold">New deadline</h2>}>
          <DeadlineForm
            scopes={scopes}
            defaultScope={scope === "*" ? "" : scope}
            onCancel={() => setMode("view")}
            onSaved={(d) => {
              setSelected(d.id);
              setView("open");
              setMode("view");
            }}
          />
        </DetailPane>
      ) : selected === undefined || all.length === 0 ? (
        <DetailPane label="Deadlines">
          <EmptyState
            title="What is due, and when"
            body="Add hackathons, grants, launches, client dates and renewals with their own time zone. The captain plans around them and reminds you ahead of time."
            action={{ label: "Add the first deadline", onClick: () => setMode("new") }}
          />
        </DetailPane>
      ) : (
        <DeadlineDetail
          key={selected}
          deadline={all.find((d) => d.id === selected)}
          scopes={scopes}
          editing={mode === "edit"}
          onEdit={() => setMode("edit")}
          onDone={() => setMode("view")}
          onGone={() => setSelected(undefined)}
        />
      )}
    </>
  );
}

function DeadlineDetail({
  deadline: d,
  scopes,
  editing,
  onEdit,
  onDone,
  onGone,
}: {
  deadline: Deadline | undefined;
  scopes: readonly Scope[];
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onGone: () => void;
}) {
  const save = useBusinessCommand("deadlines.upsert");
  const remove = useBusinessCommand("deadlines.remove");
  const contacts = useCrmList().data?.contacts ?? [];
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  if (d === undefined) {
    return (
      <DetailPane label="Deadline">
        <div className="pt-4 text-base text-fg-faint">That deadline is gone.</div>
      </DetailPane>
    );
  }
  if (editing) {
    return (
      <DetailPane label="Edit deadline" head={<h2 className="text-md font-semibold">Edit deadline</h2>}>
        <DeadlineForm initial={d} scopes={scopes} onCancel={onDone} onSaved={onDone} />
      </DetailPane>
    );
  }
  const contact = contacts.find((c) => c.id === d.contact);
  const setStatus = (status: Deadline["status"]) =>
    save.mutate(
      {
        id: d.id,
        ...(d.org === undefined ? {} : { org: d.org }),
        kind: d.kind,
        title: d.title,
        due: d.due,
        tz: d.tz,
        source: d.source,
        notes: d.notes,
        leadDays: d.leadDays,
        ...(d.goal === undefined ? {} : { goal: d.goal }),
        ...(d.finding === undefined ? {} : { finding: d.finding }),
        ...(d.contact === undefined ? {} : { contact: d.contact }),
        status,
      },
      {
        onSuccess: () => toast(status === "open" ? "Deadline reopened" : "Marked done", { detail: d.title }),
      },
    );
  const link = /^https?:\/\//i.test(d.source) ? d.source : undefined;
  return (
    <DetailPane
      label="Deadline"
      head={
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="truncate text-md font-semibold text-fg" title={d.title}>
              {d.title}
            </h2>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 text-sm text-fg-muted">
              <span className="inline-flex items-center gap-1.5">
                <Lamp state={STATE_LAMP[d.state]} size={7} />
                {d.status === "dropped" ? "Dropped" : DEADLINE_STATE_LABEL[d.state]}
              </span>
              <span>{DEADLINE_KIND_LABEL[d.kind]}</span>
              <span>{scopeLabel(scopes, d.org)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {d.status === "open" ? (
              <Button variant="primary" disabled={save.isPending} onClick={() => setStatus("done")}>
                Mark done
              </Button>
            ) : (
              <Button disabled={save.isPending} onClick={() => setStatus("open")}>
                Reopen
              </Button>
            )}
            <Button onClick={onEdit}>
              Edit <Kbd>e</Kbd>
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              Delete
            </Button>
          </div>
        </div>
      }
    >
      {save.error && (
        <div className="pt-3">
          <ErrorLine>{describeError(save.error)}</ErrorLine>
        </div>
      )}
      <div className="grid max-w-[78ch] grid-cols-[110px_1fr] gap-x-4 gap-y-2 pt-4 text-base">
        <span className="pt-px text-sm text-fg-faint">Due</span>
        <div className="flex flex-col">
          <span className="text-fg">
            {d.allDay
              ? `${fullDate(d.dueAt, d.tz).replace(/, \d\d:\d\d$/, "")}, end of day`
              : fullDate(d.dueAt, d.tz)}
          </span>
          <Meta>
            {whenWord(d)} · {d.tz}
          </Meta>
          {d.tz !== MACHINE_ZONE && <Meta>Your clock: {fullDate(d.dueAt, MACHINE_ZONE)}</Meta>}
        </div>
        <span className="pt-px text-sm text-fg-faint">Reminders</span>
        <div className="text-fg-soft">
          {d.leadDays.length === 0 ? (
            <span className="text-fg-faint">None</span>
          ) : (
            <>
              {d.leadDays.map((n) => (n === 0 ? "on the day" : `${n} d before`)).join(", ")}
              {d.nextReminder && <Meta className="ml-2">next {fullDate(d.nextReminder, d.tz)}</Meta>}
            </>
          )}
        </div>
        {d.source && (
          <>
            <span className="pt-px text-sm text-fg-faint">Source</span>
            {link ? (
              <a
                href={link}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all text-blue hover:underline"
              >
                {d.source}
              </a>
            ) : (
              <span className="break-words text-fg-soft">{d.source}</span>
            )}
          </>
        )}
        {contact && (
          <>
            <span className="pt-px text-sm text-fg-faint">Contact</span>
            <span className="text-fg-soft">{contact.name}</span>
          </>
        )}
        {d.finding !== undefined && (
          <>
            <span className="pt-px text-sm text-fg-faint">Finding</span>
            <Meta>#{d.finding}</Meta>
          </>
        )}
        {d.notes && (
          <>
            <span className="pt-px text-sm text-fg-faint">Notes</span>
            <p className="whitespace-pre-wrap break-words text-fg-soft text-pretty">{d.notes}</p>
          </>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title="Delete this deadline?"
          body="It is removed from the list and from the agenda. Mark it done instead to keep a record."
          confirmLabel="Delete"
          busy={remove.isPending}
          error={remove.error ? describeError(remove.error) : undefined}
          onCancel={() => setConfirm(false)}
          onConfirm={() =>
            remove.mutate(
              { id: d.id },
              {
                onSuccess: () => {
                  setConfirm(false);
                  onGone();
                  toast("Deadline deleted");
                },
              },
            )
          }
        />
      )}
    </DetailPane>
  );
}

function DeadlineForm({
  initial,
  scopes,
  defaultScope = "",
  onCancel,
  onSaved,
}: {
  initial?: Deadline;
  scopes: readonly Scope[];
  defaultScope?: string;
  onCancel: () => void;
  onSaved: (d: Deadline) => void;
}) {
  const save = useBusinessCommand("deadlines.upsert");
  const contacts = useCrmList().data?.contacts ?? [];
  const toast = useToast();
  const [kind, setKind] = useState<DeadlineKind>(initial?.kind ?? "hackathon");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [day, setDay] = useState(initial?.due.slice(0, 10) ?? "");
  const [time, setTime] = useState(initial?.due.slice(11) ?? "");
  const [tz, setTz] = useState(initial?.tz ?? MACHINE_ZONE);
  const [org, setOrg] = useState(initial?.org ?? defaultScope);
  const [source, setSource] = useState(initial?.source ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [lead, setLead] = useState<string[]>((initial?.leadDays ?? [14, 7, 1]).map(String));
  const [contact, setContact] = useState(initial?.contact === undefined ? "" : String(initial.contact));
  const zoneList = useMemo(zones, []);
  const leadDays = lead.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365);
  const badLead = lead.some((l) => !/^\d{1,3}$/.test(l));

  return (
    <form
      className="flex max-w-[78ch] flex-col gap-4 pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() === "" || day === "" || badLead) return;
        save.mutate(
          {
            ...(initial === undefined ? {} : { id: initial.id }),
            ...(org === "" ? {} : { org }),
            kind,
            title: title.trim(),
            due: time === "" ? day : `${day}T${time}`,
            tz,
            source,
            notes,
            leadDays,
            ...(contact === "" ? {} : { contact: Number(contact) }),
            status: initial?.status ?? "open",
          },
          {
            onSuccess: (done) => {
              toast(initial ? "Deadline saved" : "Deadline added", { detail: done.title });
              onSaved(done);
            },
          },
        );
      }}
    >
      <div className="grid grid-cols-2 gap-3 @[560px]:grid-cols-[160px_1fr]">
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as DeadlineKind)}>
              {DEADLINE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DEADLINE_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Belongs to">
          {(p) => (
            <Select {...p} value={org} onChange={(e) => setOrg(e.target.value)}>
              {scopes.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="Title">
        {(p) => (
          <Input
            {...p}
            autoFocus
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Spring hackathon, final submission"
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3 @[560px]:grid-cols-[160px_130px_1fr]">
        <Field label="Day">
          {(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}
        </Field>
        <Field label="Time" hint="Empty: end of the day.">
          {(p) => <Input {...p} type="time" value={time} onChange={(e) => setTime(e.target.value)} />}
        </Field>
        <Field label="Time zone" hint="The zone the organiser uses, not necessarily yours.">
          {(p) => (
            <>
              <Input {...p} list="business-zones" value={tz} onChange={(e) => setTz(e.target.value)} />
              <datalist id="business-zones">
                {zoneList.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </>
          )}
        </Field>
      </div>
      <Field label="Remind me, days before" error={badLead ? "Use whole numbers from 0 to 365." : undefined}>
        {(p) => (
          <ChipsInput {...p} label="Days before" value={lead} onChange={setLead} placeholder="Add a number" />
        )}
      </Field>
      <Field label="Source" hint="A link or a note on where you found it.">
        {(p) => <Input {...p} value={source} maxLength={500} onChange={(e) => setSource(e.target.value)} />}
      </Field>
      <Field label="Contact">
        {(p) => (
          <Select {...p} value={contact} onChange={(e) => setContact(e.target.value)}>
            <option value="">No one linked</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Notes">
        {(p) => (
          <Textarea
            {...p}
            value={notes}
            rows={3}
            maxLength={4000}
            onChange={(e) => setNotes(e.target.value)}
            className="font-sans"
          />
        )}
      </Field>
      {save.error && <ErrorLine>{describeError(save.error)}</ErrorLine>}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={save.isPending || title.trim() === "" || day === "" || badLead}
        >
          {initial ? "Save" : "Add deadline"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
