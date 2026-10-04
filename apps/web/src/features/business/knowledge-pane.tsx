import { KB_KIND_LABEL, KB_KINDS, type KbEntry, type KbKind, type KbRow } from "@majhi/shared";
import { useQuery } from "@tanstack/react-query";
import { Paperclip, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChipsInput } from "@/components/ui/chips-input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Lamp } from "@/components/ui/lamp";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { Select, Textarea } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Markdown } from "@/features/room/markdown";
import { type ApiRequestError, cmd, uploadFile } from "@/lib/api";
import { useBusinessCommand, useKbEntry, useKbList } from "@/lib/business-queries";
import { describeError } from "@/lib/errors";
import { formatAgo, formatBytes } from "@/lib/format";
import { queryKeys } from "@/lib/queries";
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

type Mode = { kind: "view" } | { kind: "edit" } | { kind: "new" };

/** Words typed in the search box, as the server's search sees them. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function matches(row: KbRow, words: readonly string[]): boolean {
  const hay = `${row.title} ${row.excerpt} ${row.tags.join(" ")} ${KB_KIND_LABEL[row.kind]}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function KnowledgePane({ scopes, newSignal = 0 }: { scopes: readonly Scope[]; newSignal?: number }) {
  const [view, setView] = useState<"live" | "removed">("live");
  const list = useKbList(view === "removed");
  const [scope, setScope] = useState("*");
  const [kind, setKind] = useState<"" | KbKind>("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number>();
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const now = useNow(60_000);
  const verify = useBusinessCommand("kb.verify");
  const drop = useBusinessCommand("kb.remove");
  // The header's New fact button bumps the signal.
  useEffect(() => {
    if (newSignal > 0) setMode({ kind: "new" });
  }, [newSignal]);

  const words = useMemo(
    () =>
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w !== ""),
    [query],
  );
  const q = useDebounced(query.trim(), 250);
  // Meaning-aware ranking once there is enough to search for; typing filters at once in the meantime.
  const ranked = useQuery<number[], ApiRequestError>({
    queryKey: [...queryKeys.business, "kb.search", q],
    queryFn: async () => (await cmd("kb.search", { query: q, limit: 30 })).hits.map((h) => h.entry.id),
    enabled: view === "live" && q.length >= 3,
  });

  const all = list.data?.entries ?? [];
  const rows = useMemo(() => {
    const base = all.filter((r) => inScope(scope, r.org) && (kind === "" || r.kind === kind));
    if (words.length === 0) return base;
    const local = base.filter((r) => matches(r, words));
    const order = ranked.data;
    if (order === undefined || q !== query.trim()) return local;
    const byId = new Map(base.map((r) => [r.id, r]));
    const best = order.flatMap((id) => (byId.has(id) ? [byId.get(id) as KbRow] : []));
    return [...best, ...local.filter((r) => !order.includes(r.id))];
  }, [all, scope, kind, words, ranked.data, q, query]);

  const select = useCallback((id: string | number) => {
    setSelected(Number(id));
    setMode((m) => (m.kind === "new" ? m : { kind: "view" }));
  }, []);
  const getId = useCallback((r: KbRow) => r.id, []);

  return (
    <>
      <ListShell
        label="Knowledge base"
        search={query}
        onSearch={setQuery}
        placeholder="Search facts"
        filters={
          <>
            <ScopeFilter value={scope} onChange={setScope} scopes={scopes} />
            <Select
              aria-label="Kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as "" | KbKind)}
              className="h-8 w-[112px] text-sm"
            >
              <option value="">All kinds</option>
              {KB_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KB_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </>
        }
        footer={
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => setMode({ kind: "new" })}>
              <Plus aria-hidden="true" />
              New fact
            </Button>
            <button
              type="button"
              aria-pressed={view === "removed"}
              onClick={() => {
                setView(view === "removed" ? "live" : "removed");
                setSelected(undefined);
                setMode({ kind: "view" });
              }}
              className="tnum ml-auto cursor-pointer font-mono text-xs text-fg-faint hover:text-fg"
            >
              {view === "removed" ? "Back to facts" : "Removed"}
            </button>
          </div>
        }
      >
        {list.isError ? (
          <div className="p-3">
            <ErrorLine>Could not load the knowledge base: {describeError(list.error)}</ErrorLine>
          </div>
        ) : list.data === undefined ? (
          <div className="p-2">
            <RowsSkeleton rows={6} height={48} />
          </div>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-fg-faint text-pretty">
            {all.length === 0 ? "No facts yet." : "Nothing matches. Clear the search or the filters."}
          </p>
        ) : (
          <VirtualRows
            label="Entries"
            items={rows}
            getId={getId}
            selectedId={selected}
            onSelect={select}
            row={(r, on) => {
              const proposal = !r.verified && r.by !== "owner" && view === "live";
              return (
                <RowFrame selected={on}>
                  <div className="flex min-w-0 items-center gap-2 text-xs text-fg-faint">
                    <span className="shrink-0">{KB_KIND_LABEL[r.kind]}</span>
                    <ScopeTag label={scopeLabel(scopes, r.org)} business={r.org === undefined} />
                    {r.verified ? (
                      <span className="ml-auto text-green">verified</span>
                    ) : proposal ? (
                      <span className="ml-auto text-amber-soft">proposed by the captain</span>
                    ) : null}
                  </div>
                  <span className="min-w-0 truncate text-base font-medium text-fg" title={r.title}>
                    {r.title}
                  </span>
                  {r.excerpt !== "" && (
                    <span className="min-w-0 truncate text-sm text-fg-faint">{r.excerpt}</span>
                  )}
                  {r.files.length > 0 && (
                    <span className="flex items-center gap-1.5 text-sm text-fg-faint">
                      <Paperclip className="size-3.5" aria-hidden="true" />
                      {r.files.length} {r.files.length === 1 ? "file" : "files"}
                    </span>
                  )}
                  {proposal && (
                    <div className="flex gap-1.5 pt-1">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={verify.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          verify.mutate({ id: r.id, verified: true });
                        }}
                      >
                        Verify
                      </Button>
                      <Button
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(r.id);
                          setMode({ kind: "edit" });
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        disabled={drop.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          drop.mutate({ id: r.id });
                        }}
                      >
                        Drop
                      </Button>
                    </div>
                  )}
                </RowFrame>
              );
            }}
            onKey={(e) => {
              if (e.key === "n") {
                e.preventDefault();
                setMode({ kind: "new" });
              } else if (e.key === "e" && selected !== undefined && view === "live") {
                e.preventDefault();
                setMode({ kind: "edit" });
              }
            }}
          />
        )}
      </ListShell>
      {mode.kind === "new" ? (
        <DetailPane label="New fact" head={<h2 className="text-md font-semibold">New fact</h2>}>
          <EntryForm
            scopes={scopes}
            defaultScope={scope === "*" ? "" : scope}
            onCancel={() => setMode({ kind: "view" })}
            onSaved={(entry) => {
              setSelected(entry.id);
              setMode({ kind: "view" });
              setView("live");
            }}
          />
        </DetailPane>
      ) : selected === undefined || list.data?.entries.length === 0 ? (
        <DetailPane label="Knowledge base">
          <EmptyState
            title="No facts yet"
            body="Add one and the captain can use it."
            action={{ label: "New fact", onClick: () => setMode({ kind: "new" }) }}
          />
        </DetailPane>
      ) : (
        <EntryDetail
          key={selected}
          id={selected}
          scopes={scopes}
          editing={mode.kind === "edit"}
          onEdit={() => setMode({ kind: "edit" })}
          onDone={() => setMode({ kind: "view" })}
          now={now}
        />
      )}
    </>
  );
}

function EntryDetail({
  id,
  scopes,
  editing,
  onEdit,
  onDone,
  now,
}: {
  id: number;
  scopes: readonly Scope[];
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  now: number;
}) {
  const [version, setVersion] = useState<number>();
  const current = useKbEntry(id);
  const shown = useKbEntry(id, version);
  const verify = useBusinessCommand("kb.verify");
  const remove = useBusinessCommand("kb.remove");
  const restore = useBusinessCommand("kb.restore");
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const data = version === undefined ? current.data : (shown.data ?? current.data);

  if (current.isError) {
    return (
      <DetailPane label="Entry">
        <div className="pt-4">
          <ErrorLine>Could not load this entry: {describeError(current.error)}</ErrorLine>
        </div>
      </DetailPane>
    );
  }
  if (data === undefined || current.data === undefined) {
    return (
      <DetailPane label="Entry">
        <div className="pt-4">
          <RowsSkeleton rows={4} height={40} />
        </div>
      </DetailPane>
    );
  }
  const entry = data.entry;
  const live = current.data.entry;
  const old = version !== undefined && version !== live.version;

  if (editing && !old && !current.data.removed) {
    return (
      <DetailPane label="Edit fact" head={<h2 className="text-md font-semibold">Edit fact</h2>}>
        <EntryForm initial={live} scopes={scopes} onCancel={onDone} onSaved={onDone} />
      </DetailPane>
    );
  }
  const err = verify.error ?? remove.error ?? restore.error;
  return (
    <DetailPane
      label="Entry"
      head={
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="truncate text-md font-semibold text-fg" title={entry.title}>
              {entry.title}
            </h2>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 text-sm text-fg-muted">
              <span>{KB_KIND_LABEL[entry.kind]}</span>
              <span>{scopeLabel(scopes, entry.org)}</span>
              <span className="inline-flex items-center gap-1.5">
                <Lamp state={entry.verified ? "done" : "paused"} size={7} />
                {entry.verified ? "Verified by you" : `Not verified, from ${entry.by}`}
              </span>
              <Meta>
                v{entry.version} · {formatAgo(entry.updatedAt, now)}
              </Meta>
            </div>
          </div>
        </div>
      }
    >
      {old && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-caution-line bg-caution-wash px-3 py-2 text-base">
          <span className="min-w-0 flex-1 text-pretty">
            You are reading version {version}, not the current text.
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={restore.isPending}
            onClick={() =>
              restore.mutate(
                { id, version: version as number },
                {
                  onSuccess: () => {
                    setVersion(undefined);
                    toast("Version restored", { detail: "Saved as a new version." });
                  },
                },
              )
            }
          >
            Restore this version
          </Button>
          <Button size="sm" onClick={() => setVersion(undefined)}>
            Back to current
          </Button>
        </div>
      )}
      {err && (
        <div className="pt-3">
          <ErrorLine>{describeError(err)}</ErrorLine>
        </div>
      )}
      <div className="max-w-[78ch] pt-4">
        {entry.body.trim() === "" ? (
          <p className="text-base text-fg-faint">No text yet. Edit the entry to add it.</p>
        ) : (
          <Markdown text={entry.body} size="document" />
        )}
      </div>
      {entry.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-4">
          {entry.tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-line-control px-2 py-px text-xs text-fg-muted"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {(entry.sources.length > 0 || entry.files.length > 0) && (
        <DetailSection title="Sources and files" className="mt-5">
          <ul className="flex flex-col gap-1 text-base text-fg-soft">
            {entry.sources.map((s) => (
              <li key={s} className="break-words">
                {s}
              </li>
            ))}
            {entry.files.map((f) => (
              <li key={f.id} className="flex items-center gap-2">
                <Paperclip className="size-3.5 text-fg-faint" aria-hidden="true" />
                <span className="min-w-0 truncate">{f.name}</span>
                {f.size !== undefined && <Meta>{formatBytes(f.size)}</Meta>}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
      <DetailSection title="History" className="mt-5">
        <ul className="flex flex-col">
          {current.data.versions.map((v) => {
            const on = (version ?? live.version) === v.version;
            return (
              <li key={v.version} className="flex items-center gap-2 border-t border-line first:border-t-0">
                <button
                  type="button"
                  onClick={() => setVersion(v.version === live.version ? undefined : v.version)}
                  aria-current={on ? "true" : undefined}
                  className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-3 rounded-md px-1 py-1.5 text-left text-base hover:bg-raised"
                >
                  <Meta className="w-8 shrink-0">v{v.version}</Meta>
                  <span className={on ? "text-fg" : "text-fg-soft"}>{CHANGE_WORD[v.change]}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-faint">{v.by}</span>
                  <Meta>{formatAgo(v.at, now)}</Meta>
                </button>
                {v.version !== live.version && !current.data.removed && (
                  <button
                    type="button"
                    disabled={restore.isPending}
                    onClick={() =>
                      restore.mutate(
                        { id, version: v.version },
                        {
                          onSuccess: () => {
                            setVersion(undefined);
                            toast("Version restored", { detail: "Saved as a new version." });
                          },
                        },
                      )
                    }
                    className="shrink-0 cursor-pointer font-mono text-xs text-amber-soft hover:underline"
                  >
                    Restore v{v.version}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </DetailSection>
      <div className="flex shrink-0 items-center gap-2 pt-5">
        {current.data.removed ? (
          <Button
            variant="primary"
            disabled={restore.isPending}
            onClick={() =>
              restore.mutate({ id }, { onSuccess: () => toast("Entry restored", { detail: live.title }) })
            }
          >
            Restore
          </Button>
        ) : (
          <>
            <Button
              variant={live.verified ? "secondary" : "primary"}
              disabled={verify.isPending || old}
              onClick={() =>
                verify.mutate(
                  { id, verified: !live.verified },
                  { onSuccess: () => toast(live.verified ? "Verification taken back" : "Verified") },
                )
              }
            >
              {live.verified ? "Unverify" : "Verify"}
            </Button>
            <Button onClick={onEdit} disabled={old}>
              Edit <Kbd>e</Kbd>
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          </>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title="Remove this entry?"
          body="It leaves the lists and the captain's search. You can restore it from Removed."
          confirmLabel="Remove"
          busy={remove.isPending}
          error={remove.error ? describeError(remove.error) : undefined}
          onCancel={() => setConfirm(false)}
          onConfirm={() =>
            remove.mutate(
              { id },
              {
                onSuccess: () => {
                  setConfirm(false);
                  toast("Entry removed", { detail: live.title });
                },
              },
            )
          }
        />
      )}
    </DetailPane>
  );
}

const CHANGE_WORD = {
  create: "Created",
  edit: "Edited",
  verify: "Verification changed",
  restore: "Restored",
  remove: "Removed",
} as const;

function EntryForm({
  initial,
  scopes,
  defaultScope = "",
  onCancel,
  onSaved,
}: {
  initial?: KbEntry;
  scopes: readonly Scope[];
  defaultScope?: string;
  onCancel: () => void;
  onSaved: (entry: KbEntry) => void;
}) {
  const save = useBusinessCommand("kb.upsert");
  const toast = useToast();
  const [kind, setKind] = useState<KbKind>(initial?.kind ?? "about");
  const [org, setOrg] = useState(initial?.org ?? defaultScope);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [sources, setSources] = useState((initial?.sources ?? []).join("\n"));
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [uploadError, setUploadError] = useState<string>();

  const submit = () =>
    save.mutate(
      {
        ...(initial === undefined ? {} : { id: initial.id }),
        ...(org === "" ? {} : { org }),
        kind,
        title: title.trim(),
        body,
        tags,
        sources: sources
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
        uploads: files.map((f) => f.id),
      },
      {
        onSuccess: (done) => {
          toast(done.created ? "Entry added" : "Entry saved", { detail: done.entry.title });
          onSaved(done.entry);
        },
      },
    );

  return (
    <form
      className="flex max-w-[78ch] flex-col gap-4 pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() !== "") submit();
      }}
    >
      <div className="grid grid-cols-2 gap-3 @[560px]:grid-cols-[160px_1fr]">
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as KbKind)}>
              {KB_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KB_KIND_LABEL[k]}
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
            placeholder="Pricing, 2026"
          />
        )}
      </Field>
      <Field label="Text (Markdown)" hint={`${body.length.toLocaleString()} of 40,000 characters`}>
        {(p) => (
          <Textarea
            {...p}
            value={body}
            maxLength={40_000}
            rows={12}
            onChange={(e) => setBody(e.target.value)}
            className="font-sans"
          />
        )}
      </Field>
      <Field label="Tags">
        {(p) => <ChipsInput {...p} label="Tags" value={tags} onChange={setTags} placeholder="Add a tag" />}
      </Field>
      <Field label="Sources, one per line" hint="Links or notes that say where this comes from.">
        {(p) => (
          <Textarea
            {...p}
            value={sources}
            rows={3}
            onChange={(e) => setSources(e.target.value)}
            className="font-sans"
          />
        )}
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm text-fg-faint">Files</span>
        <div className="flex flex-wrap items-center gap-2">
          {files.map((f) => (
            <span
              key={f.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-line-control py-px pr-1 pl-2.5 text-sm"
            >
              {f.name}
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                className="cursor-pointer rounded-full p-0.5 text-fg-faint hover:text-fg"
                onClick={() => setFiles((l) => l.filter((x) => x.id !== f.id))}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line-control bg-raised px-2.5 text-sm text-fg hover:border-line-hover">
            <Paperclip className="size-3.5" aria-hidden="true" />
            Attach a file
            <input
              type="file"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setUploadError(undefined);
                uploadFile(file).then(
                  (a) => setFiles((l) => [...l, { id: a.id, name: a.name }]),
                  (err: unknown) => setUploadError(describeError(err)),
                );
              }}
            />
          </label>
        </div>
        {uploadError && <ErrorLine>{uploadError}</ErrorLine>}
      </div>
      {save.error && <ErrorLine>{describeError(save.error)}</ErrorLine>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending || title.trim() === ""}>
          {initial ? "Save" : "Add entry"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
        <span className="text-sm text-fg-faint">Your entries start verified.</span>
      </div>
    </form>
  );
}
