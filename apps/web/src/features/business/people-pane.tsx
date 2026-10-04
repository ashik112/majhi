import {
  CRM_CHANNELS,
  CRM_PIPELINE_RELATIONS,
  CRM_RELATION_LABEL,
  CRM_RELATIONS,
  CRM_STAGE_LABEL,
  CRM_STAGES,
  type CrmChannel,
  type CrmContact,
  type CrmRelation,
  type CrmStage,
} from "@majhi/shared";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChipsInput } from "@/components/ui/chips-input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { Segmented } from "@/components/ui/segmented";
import { Select, Textarea } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useBusinessCommand, useCrmContact, useCrmList } from "@/lib/business-queries";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useNow } from "@/lib/use-now";
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

type Mode = "view" | "edit" | "new";

const today = () => new Date().toLocaleDateString("en-CA");

function searchable(c: CrmContact): string {
  return [c.name, c.company, c.role, c.emails.join(" "), c.links.join(" "), c.notes, c.tags.join(" ")]
    .join(" ")
    .toLowerCase();
}

/** A http(s) link the page may open; anything else stays text. */
function hrefOf(link: string): string | undefined {
  const full = /^https?:\/\//i.test(link) ? link : `https://${link}`;
  try {
    const url = new URL(full);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function PeoplePane({ scopes }: { scopes: readonly Scope[] }) {
  const list = useCrmList();
  const [scope, setScope] = useState("*");
  const [relation, setRelation] = useState<"" | CrmRelation>("");
  const [view, setView] = useState<"all" | "due">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number>();
  const [mode, setMode] = useState<Mode>("view");
  const now = useNow(60_000);

  const all = list.data?.contacts ?? [];
  const due = useMemo(
    () => all.filter((c) => c.nextDue !== undefined && c.stage !== "won" && c.stage !== "lost"),
    [all],
  );
  const rows = useMemo(() => {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== "");
    const base = (
      view === "due" ? [...due].sort((a, b) => (a.nextDue ?? "").localeCompare(b.nextDue ?? "")) : all
    ).filter((c) => inScope(scope, c.org) && (relation === "" || c.relation === relation));
    return words.length === 0 ? base : base.filter((c) => words.every((w) => searchable(c).includes(w)));
  }, [all, due, view, scope, relation, query]);

  const select = useCallback((id: string | number) => {
    setSelected(Number(id));
    setMode((m) => (m === "new" ? m : "view"));
  }, []);
  const getId = useCallback((c: CrmContact) => c.id, []);

  return (
    <>
      <ListShell
        label="People"
        search={query}
        onSearch={setQuery}
        placeholder="Search people and organisations"
        filters={
          <>
            <ScopeFilter value={scope} onChange={setScope} scopes={scopes} />
            <Select
              aria-label="Relation"
              value={relation}
              onChange={(e) => setRelation(e.target.value as "" | CrmRelation)}
              className="h-8 w-[112px] text-sm"
            >
              <option value="">Everyone</option>
              {CRM_RELATIONS.map((r) => (
                <option key={r} value={r}>
                  {CRM_RELATION_LABEL[r]}
                </option>
              ))}
            </Select>
          </>
        }
        footer={
          <div className="flex flex-col gap-2">
            <Segmented
              label="Show people"
              value={view}
              segments={[
                { value: "all", label: "All", count: all.length },
                { value: "due", label: "Next steps", count: due.length },
              ]}
              onChange={setView}
              className="[&_button]:h-7"
            />
            <Button variant="primary" className="w-full" onClick={() => setMode("new")}>
              New person <Kbd>n</Kbd>
            </Button>
          </div>
        }
      >
        {list.isError ? (
          <div className="p-3">
            <ErrorLine>Could not load people: {describeError(list.error)}</ErrorLine>
          </div>
        ) : list.data === undefined ? (
          <div className="p-2">
            <RowsSkeleton rows={6} height={48} />
          </div>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-fg-faint text-pretty">
            {all.length === 0
              ? "No one yet."
              : view === "due"
                ? "No next steps are set. Add one to a person and it shows here."
                : "Nothing matches. Clear the search or the filters."}
          </p>
        ) : (
          <VirtualRows
            label="People"
            items={rows}
            getId={getId}
            selectedId={selected}
            onSelect={select}
            estimate={54}
            row={(c, on) => (
              <RowFrame selected={on}>
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-base text-fg" title={c.name}>
                    {c.name}
                  </span>
                  {c.nextDue && c.stage !== "won" && c.stage !== "lost" && (
                    <Meta className={c.nextDue < today() ? "text-red" : undefined}>{c.nextDue.slice(5)}</Meta>
                  )}
                </div>
                <div className="flex min-w-0 items-baseline gap-2 text-xs text-fg-faint">
                  <span className="shrink-0">{CRM_RELATION_LABEL[c.relation]}</span>
                  {c.stage && <span className="shrink-0">{CRM_STAGE_LABEL[c.stage]}</span>}
                  <span className="min-w-0 flex-1 truncate">
                    {[c.role, c.company].filter(Boolean).join(", ")}
                  </span>
                  <ScopeTag label={scopeLabel(scopes, c.org)} business={c.org === undefined} />
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
        <DetailPane label="New person" head={<h2 className="text-md font-semibold">New person</h2>}>
          <ContactForm
            scopes={scopes}
            defaultScope={scope === "*" ? "" : scope}
            onCancel={() => setMode("view")}
            onSaved={(c) => {
              setSelected(c.id);
              setMode("view");
            }}
          />
        </DetailPane>
      ) : selected === undefined || all.length === 0 ? (
        <DetailPane label="People">
          <EmptyState
            title="Who the business deals with"
            body="Keep clients, leads, investors, partners and the people behind hackathons and grants here, with the last touch and the next step. The same email or link is one person, so nothing doubles."
            action={{ label: "Add the first person", onClick: () => setMode("new") }}
          />
        </DetailPane>
      ) : (
        <ContactDetail
          key={selected}
          id={selected}
          scopes={scopes}
          all={all}
          editing={mode === "edit"}
          onEdit={() => setMode("edit")}
          onDone={() => setMode("view")}
          onGone={() => setSelected(undefined)}
          now={now}
        />
      )}
    </>
  );
}

function ContactDetail({
  id,
  scopes,
  all,
  editing,
  onEdit,
  onDone,
  onGone,
  now,
}: {
  id: number;
  scopes: readonly Scope[];
  all: readonly CrmContact[];
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onGone: () => void;
  now: number;
}) {
  const got = useCrmContact(id);
  const remove = useBusinessCommand("crm.remove");
  const merge = useBusinessCommand("crm.merge");
  const toast = useToast();
  const [confirm, setConfirm] = useState<"delete" | "merge" | undefined>();
  const [other, setOther] = useState("");

  if (got.isError) {
    return (
      <DetailPane label="Person">
        <div className="pt-4">
          <ErrorLine>Could not load this person: {describeError(got.error)}</ErrorLine>
        </div>
      </DetailPane>
    );
  }
  if (got.data === undefined) {
    return (
      <DetailPane label="Person">
        <div className="pt-4">
          <RowsSkeleton rows={4} height={40} />
        </div>
      </DetailPane>
    );
  }
  const { contact: c, interactions } = got.data;
  if (editing) {
    return (
      <DetailPane label="Edit person" head={<h2 className="text-md font-semibold">Edit {c.name}</h2>}>
        <ContactForm initial={c} scopes={scopes} onCancel={onDone} onSaved={onDone} />
      </DetailPane>
    );
  }
  const candidates = all.filter((x) => x.id !== c.id);
  return (
    <DetailPane
      label="Person"
      head={
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="truncate text-md font-semibold text-fg" title={c.name}>
              {c.name}
            </h2>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 text-sm text-fg-muted">
              <span>{CRM_RELATION_LABEL[c.relation]}</span>
              {c.stage && <span>{CRM_STAGE_LABEL[c.stage]}</span>}
              {(c.role || c.company) && (
                <span className="truncate">{[c.role, c.company].filter(Boolean).join(", ")}</span>
              )}
              <span>{scopeLabel(scopes, c.org)}</span>
              {c.ownerOnly && <span className="text-lamp-paused">Hidden from the captain</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button onClick={onEdit}>
              Edit <Kbd>e</Kbd>
            </Button>
            <Button variant="ghost" disabled={candidates.length === 0} onClick={() => setConfirm("merge")}>
              Merge into
            </Button>
            <Button variant="ghost" onClick={() => setConfirm("delete")}>
              Delete
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid max-w-[78ch] grid-cols-[110px_1fr] gap-x-4 gap-y-2 pt-4 text-base">
        <Row label="Next step">
          {c.nextStep || c.nextDue ? (
            <span className="text-fg">
              {c.nextStep}
              {c.nextDue && (
                <Meta
                  className={
                    c.nextDue < today() && c.stage !== "won" && c.stage !== "lost" ? "ml-2 text-red" : "ml-2"
                  }
                >
                  {c.nextDue}
                </Meta>
              )}
            </span>
          ) : (
            <span className="text-fg-faint">None set</span>
          )}
        </Row>
        <Row label="Last touch">
          {c.lastTouch ? (
            <span className="text-fg-soft">{formatAgo(c.lastTouch, now)}</span>
          ) : (
            <span className="text-fg-faint">Never logged</span>
          )}
        </Row>
        {c.emails.length > 0 && (
          <Row label="Email">
            <span className="flex flex-col font-mono text-sm text-fg-soft">
              {c.emails.map((e) => (
                <span key={e} className="break-all">
                  {e}
                </span>
              ))}
            </span>
          </Row>
        )}
        {c.links.length > 0 && (
          <Row label="Links">
            <span className="flex flex-col text-sm">
              {c.links.map((l) => {
                const href = hrefOf(l);
                return href ? (
                  <a
                    key={l}
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="break-all text-blue hover:underline"
                  >
                    {l}
                  </a>
                ) : (
                  <span key={l} className="break-all text-fg-soft">
                    {l}
                  </span>
                );
              })}
            </span>
          </Row>
        )}
        {c.tags.length > 0 && (
          <Row label="Tags">
            <span className="flex flex-wrap gap-1.5">
              {c.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-line-control px-2 py-px text-xs text-fg-muted"
                >
                  {t}
                </span>
              ))}
            </span>
          </Row>
        )}
        {c.notes && (
          <Row label="Notes">
            <p className="whitespace-pre-wrap break-words text-fg-soft text-pretty">{c.notes}</p>
          </Row>
        )}
      </div>
      <DetailSection title="Interactions" className="mt-5">
        <LogForm contact={c.id} />
        {interactions.length === 0 ? (
          <p className="text-base text-fg-faint">
            Nothing logged yet. Note the last mail, call or meeting above.
          </p>
        ) : (
          <ul className="flex flex-col">
            {interactions.map((i) => (
              <li
                key={i.id}
                className="flex min-w-0 items-baseline gap-3 border-t border-line py-2 first:border-t-0"
              >
                <Meta className="w-[74px] shrink-0">{i.at.slice(0, 10)}</Meta>
                <span className="w-[62px] shrink-0 text-sm text-fg-faint">{i.channel}</span>
                <span className="min-w-0 flex-1 break-words text-base text-fg-soft text-pretty">
                  {i.summary}
                </span>
                <span className="shrink-0 text-xs text-fg-faint">{i.by}</span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
      {confirm === "delete" && (
        <ConfirmDialog
          title="Delete this person?"
          body="The person and every interaction logged for them are deleted. This cannot be undone."
          confirmLabel="Delete"
          busy={remove.isPending}
          error={remove.error ? describeError(remove.error) : undefined}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() =>
            remove.mutate(
              { id },
              {
                onSuccess: () => {
                  setConfirm(undefined);
                  onGone();
                  toast("Person deleted");
                },
              },
            )
          }
        />
      )}
      {confirm === "merge" && (
        <ConfirmDialog
          title="Merge into another person?"
          body={
            <div className="flex flex-col gap-3">
              <p>
                {c.name} is folded into the person you pick. Their emails, links, notes and interactions move
                over; where both have a value, the person you pick keeps theirs.
              </p>
              <Select aria-label="Keep this person" value={other} onChange={(e) => setOther(e.target.value)}>
                <option value="">Pick the person to keep</option>
                {candidates.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.company ? `, ${x.company}` : ""}
                  </option>
                ))}
              </Select>
            </div>
          }
          confirmLabel="Merge"
          confirmDisabled={other === ""}
          busy={merge.isPending}
          error={merge.error ? describeError(merge.error) : undefined}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() =>
            merge.mutate(
              { keep: Number(other), drop: id },
              {
                onSuccess: (done) => {
                  setConfirm(undefined);
                  toast(
                    "People merged",
                    done.conflicts.length > 0
                      ? { detail: `${done.conflicts.length} fields differed; the kept values stayed.` }
                      : {},
                  );
                  onGone();
                },
              },
            )
          }
        />
      )}
    </DetailPane>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="pt-px text-sm text-fg-faint">{label}</span>
      <div className="min-w-0">{children}</div>
    </>
  );
}

function LogForm({ contact }: { contact: number }) {
  const log = useBusinessCommand("crm.log");
  const [channel, setChannel] = useState<CrmChannel>("mail");
  const [summary, setSummary] = useState("");
  const [day, setDay] = useState(today());
  const toast = useToast();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (summary.trim() === "") return;
        log.mutate(
          {
            contact,
            channel,
            summary: summary.trim(),
            ...(day === today() ? {} : { at: new Date(`${day}T12:00:00`).toISOString() }),
          },
          {
            onSuccess: () => {
              setSummary("");
              toast("Interaction logged");
            },
          },
        );
      }}
    >
      <Select
        aria-label="Channel"
        value={channel}
        onChange={(e) => setChannel(e.target.value as CrmChannel)}
        className="w-[96px]"
      >
        {CRM_CHANNELS.map((ch) => (
          <option key={ch} value={ch}>
            {ch}
          </option>
        ))}
      </Select>
      <Input
        aria-label="Day"
        type="date"
        value={day}
        max={today()}
        onChange={(e) => setDay(e.target.value)}
        className="w-[140px]"
      />
      <Input
        aria-label="What happened"
        placeholder="What happened, in a line"
        value={summary}
        maxLength={2000}
        onChange={(e) => setSummary(e.target.value)}
        className="min-w-[200px] flex-1"
      />
      <Button type="submit" disabled={log.isPending || summary.trim() === ""}>
        Log
      </Button>
      {log.error && (
        <div className="w-full">
          <ErrorLine>{describeError(log.error)}</ErrorLine>
        </div>
      )}
    </form>
  );
}

function ContactForm({
  initial,
  scopes,
  defaultScope = "",
  onCancel,
  onSaved,
}: {
  initial?: CrmContact;
  scopes: readonly Scope[];
  defaultScope?: string;
  onCancel: () => void;
  onSaved: (c: CrmContact) => void;
}) {
  const save = useBusinessCommand("crm.upsert");
  const toast = useToast();
  const [kind, setKind] = useState(initial?.kind ?? "person");
  const [relation, setRelation] = useState<CrmRelation>(initial?.relation ?? "lead");
  const [name, setName] = useState(initial?.name ?? "");
  const [company, setCompany] = useState(initial?.company ?? "");
  const [role, setRole] = useState(initial?.role ?? "");
  const [emails, setEmails] = useState<string[]>(initial?.emails ?? []);
  const [links, setLinks] = useState((initial?.links ?? []).join("\n"));
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [org, setOrg] = useState(initial?.org ?? defaultScope);
  const [ownerOnly, setOwnerOnly] = useState(initial?.ownerOnly ?? false);
  const [stage, setStage] = useState<"" | CrmStage>(initial?.stage ?? "");
  const [nextStep, setNextStep] = useState(initial?.nextStep ?? "");
  const [nextDue, setNextDue] = useState(initial?.nextDue ?? "");
  const pipeline = CRM_PIPELINE_RELATIONS.includes(relation);

  return (
    <form
      className="flex max-w-[78ch] flex-col gap-4 pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() === "") return;
        save.mutate(
          {
            ...(initial === undefined ? {} : { id: initial.id }),
            ...(org === "" ? {} : { org }),
            kind,
            relation,
            name: name.trim(),
            company,
            role,
            emails,
            links: links
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l !== ""),
            notes,
            tags,
            ownerOnly,
            ...(pipeline && stage !== "" ? { stage } : {}),
            nextStep,
            ...(nextDue === "" ? {} : { nextDue }),
          },
          {
            onSuccess: (done) => {
              toast(
                done.result === "created"
                  ? "Person added"
                  : done.result === "merged"
                    ? "Joined an existing person"
                    : "Person saved",
                done.merged.length > 0
                  ? { detail: `${done.merged.length} duplicate${done.merged.length === 1 ? "" : "s"} folded in.` }
                  : done.result === "merged"
                    ? { detail: "The same email or link was already here." }
                    : {},
              );
              onSaved(done.contact);
            },
          },
        );
      }}
    >
      <div className="grid grid-cols-2 gap-3 @[560px]:grid-cols-4">
        <Field label="Is a">
          {(p) => (
            <Select
              {...p}
              value={kind}
              onChange={(e) => setKind(e.target.value as "person" | "organisation")}
            >
              <option value="person">Person</option>
              <option value="organisation">Organisation</option>
            </Select>
          )}
        </Field>
        <Field label="Relation">
          {(p) => (
            <Select {...p} value={relation} onChange={(e) => setRelation(e.target.value as CrmRelation)}>
              {CRM_RELATIONS.map((r) => (
                <option key={r} value={r}>
                  {CRM_RELATION_LABEL[r]}
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
        {pipeline && (
          <Field label="Stage">
            {(p) => (
              <Select {...p} value={stage} onChange={(e) => setStage(e.target.value as "" | CrmStage)}>
                <option value="">No stage</option>
                {CRM_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {CRM_STAGE_LABEL[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 @[560px]:grid-cols-3">
        <Field label="Name">
          {(p) => (
            <Input {...p} autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        <Field label={kind === "person" ? "Company" : "Parent organisation"}>
          {(p) => (
            <Input {...p} value={company} maxLength={200} onChange={(e) => setCompany(e.target.value)} />
          )}
        </Field>
        <Field label="Role">
          {(p) => <Input {...p} value={role} maxLength={200} onChange={(e) => setRole(e.target.value)} />}
        </Field>
      </div>
      <Field label="Emails" hint="The same email in the same workspace is the same person.">
        {(p) => (
          <ChipsInput {...p} label="Emails" value={emails} onChange={setEmails} placeholder="Add an email" />
        )}
      </Field>
      <Field label="Links, one per line">
        {(p) => (
          <Textarea
            {...p}
            value={links}
            rows={2}
            onChange={(e) => setLinks(e.target.value)}
            className="font-sans"
          />
        )}
      </Field>
      <div className="grid grid-cols-1 gap-3 @[560px]:grid-cols-[1fr_160px]">
        <Field label="Next step">
          {(p) => (
            <Input
              {...p}
              value={nextStep}
              maxLength={300}
              onChange={(e) => setNextStep(e.target.value)}
              placeholder="Send the deck"
            />
          )}
        </Field>
        <Field label="Due">
          {(p) => <Input {...p} type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />}
        </Field>
      </div>
      <Field label="Notes">
        {(p) => (
          <Textarea
            {...p}
            value={notes}
            rows={4}
            maxLength={8000}
            onChange={(e) => setNotes(e.target.value)}
            className="font-sans"
          />
        )}
      </Field>
      <Field label="Tags">
        {(p) => <ChipsInput {...p} label="Tags" value={tags} onChange={setTags} placeholder="Add a tag" />}
      </Field>
      <Switch
        label="Hide from the captain and every agent"
        checked={ownerOnly}
        onChange={setOwnerOnly}
        title="Owner-only people are never shown to the captain or an agent."
      />
      {save.error && <ErrorLine>{describeError(save.error)}</ErrorLine>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending || name.trim() === ""}>
          {initial ? "Save" : "Add person"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
