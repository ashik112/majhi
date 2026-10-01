import {
  activeFields,
  activeLists,
  type ConnectionField,
  type ConnectionList,
  type ConnectionType,
  type ConnectionView,
  type FieldKind,
} from "@majhi/shared";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { useSshHosts } from "@/lib/task-queries";
import {
  type ConnectionDraft,
  type DraftEntry,
  entryKey,
  entryNameProblem,
  filledFields,
  KIND_LABEL,
} from "./model";
import { FileInput, SecretInput } from "./value-controls";

/**
 * The fields of a connection's type that count for what is filled in (a remote MCP server has a URL,
 * a local one a command), then its lists. Text goes into the draft; a secret or a file is set at once
 * on a connection that exists, so a new one gets them after it is created.
 */
export function ConnectionFields({
  type,
  draft,
  onChange,
  view,
}: {
  type: ConnectionType;
  draft: ConnectionDraft;
  onChange: (draft: ConnectionDraft) => void;
  /** The saved connection, for its secrets and files. Absent while it is being created. */
  view?: ConnectionView | undefined;
}) {
  const values = filledFields(draft);
  const fields = activeFields(type, values);
  const lists = activeLists(type, values);
  return (
    <div className="flex flex-col gap-4">
      {fields.length > 0 && (
        <div className="grid gap-3 @[560px]:grid-cols-2">
          {fields.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              text={draft.fields[field.key] ?? ""}
              view={view}
              onText={(text) => onChange({ ...draft, fields: { ...draft.fields, [field.key]: text } })}
            />
          ))}
        </div>
      )}
      {lists.map((list) => (
        <ListEditor
          key={list.key}
          list={list}
          entries={draft.lists[list.key]}
          view={view}
          onChange={(entries) => onChange({ ...draft, lists: { ...draft.lists, [list.key]: entries } })}
        />
      ))}
    </div>
  );
}

function FieldControl({
  field,
  text,
  view,
  onText,
}: {
  field: ConnectionField;
  text: string;
  view: ConnectionView | undefined;
  onText: (text: string) => void;
}) {
  if (field.choices !== undefined) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5 @[560px]:col-span-2">
        <span className="text-sm text-fg-faint">{field.label}</span>
        <Segmented
          label={field.label}
          value={text}
          segments={field.choices.map((c) => ({ value: c.value, label: c.label }))}
          onChange={onText}
          className="self-start"
        />
        <p className="text-sm text-fg-faint text-pretty">{field.help}</p>
      </div>
    );
  }
  return (
    <Field label={field.required ? field.label : `${field.label} (optional)`} hint={field.help}>
      {(p) =>
        field.kind === "secret" ? (
          view === undefined ? (
            <Later {...p} />
          ) : (
            <SecretInput
              id={view.id}
              field={field.key}
              label={field.label}
              value={view.fields[field.key]}
              inputId={p.id}
              describedBy={p["aria-describedby"]}
            />
          )
        ) : field.kind === "file" ? (
          view === undefined ? (
            <Later {...p} />
          ) : (
            <FileInput
              id={view.id}
              field={field.key}
              label={field.label}
              value={view.fields[field.key]}
              inputId={p.id}
              describedBy={p["aria-describedby"]}
            />
          )
        ) : field.pick === "ssh-alias" ? (
          <SshAliasSelect {...p} value={text} onChange={onText} />
        ) : (
          <Input
            {...p}
            value={text}
            placeholder={field.placeholder}
            className={cn(field.format !== undefined && "font-mono")}
            onChange={(e) => onText(e.target.value)}
          />
        )
      }
    </Field>
  );
}

/** Where a secret or a file goes before the connection exists. */
function Later({ id }: { id: string }) {
  return (
    <p id={id} className="flex h-[34px] items-center text-base text-fg-faint">
      Set it once the connection is created
    </p>
  );
}

/** The Host aliases of ~/.ssh/config. A value that is no longer there stays offered, marked. */
function SshAliasSelect({
  value,
  onChange,
  ...p
}: {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  const hosts = useSshHosts().data ?? [];
  const known = hosts.some((h) => h.alias === value);
  return (
    <Select {...p} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono">
      <option value="">{hosts.length === 0 ? "No Host entries in ~/.ssh/config" : "Pick a host"}</option>
      {value !== "" && !known && <option value={value}>{value} (not in ~/.ssh/config)</option>}
      {hosts.map((h) => (
        <option key={h.alias} value={h.alias}>
          {h.alias}
          {h.hostName ? ` · ${h.hostName}` : ""}
        </option>
      ))}
    </Select>
  );
}

/** The owner's own entries: a name, a kind and the value, one row each. */
function ListEditor({
  list,
  entries,
  view,
  onChange,
}: {
  list: ConnectionList;
  entries: readonly DraftEntry[];
  view: ConnectionView | undefined;
  onChange: (entries: DraftEntry[]) => void;
}) {
  const noun = list.names === "header" ? "header" : "variable";
  const saved = view?.[list.key] ?? {};
  const update = (key: string, patch: Partial<DraftEntry>) =>
    onChange(entries.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  return (
    <section aria-label={list.label} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h4 className="text-sm font-medium text-fg-soft">{list.label}</h4>
        <span className="text-sm text-fg-faint text-pretty">{list.help}</span>
      </div>
      {entries.length > 0 && (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => {
            const name = entry.name.trim();
            const problem = entry.name === "" ? undefined : entryNameProblem(list.names, entry, entries);
            const stored = saved[name];
            const live = view !== undefined && stored !== undefined && stored.kind === entry.kind;
            return (
              <li
                key={entry.key}
                className="grid items-start gap-2 grid-cols-[minmax(0,1fr)_96px_minmax(0,1.5fr)_28px]"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <Input
                    aria-label={`Name of the ${noun}`}
                    aria-invalid={problem ? true : undefined}
                    className="font-mono"
                    value={entry.name}
                    placeholder={list.names === "header" ? "Api-Key" : "API_KEY"}
                    onChange={(e) => update(entry.key, { name: e.target.value })}
                  />
                  {problem && <p className="text-sm text-red text-pretty">{problem}</p>}
                </div>
                <Select
                  aria-label={`Kind of ${name || `the ${noun}`}`}
                  value={entry.kind}
                  onChange={(e) => update(entry.key, { kind: e.target.value as FieldKind })}
                >
                  {list.kinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABEL[kind]}
                    </option>
                  ))}
                </Select>
                {entry.kind === "text" ? (
                  <Input
                    aria-label={`Value of ${name || `the ${noun}`}`}
                    value={entry.value}
                    onChange={(e) => update(entry.key, { value: e.target.value })}
                  />
                ) : live && entry.kind === "secret" ? (
                  <SecretInput id={view.id} field={name} list={list.key} label={name} value={stored} />
                ) : live ? (
                  <FileInput id={view.id} field={name} list={list.key} label={name} value={stored} />
                ) : (
                  <p className="flex h-[34px] items-center text-sm text-fg-faint">
                    {view === undefined ? "Set it once the connection is created" : "Save, then set it here"}
                  </p>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="mt-[3px]"
                  aria-label={`Remove ${name || `the ${noun}`}`}
                  title="Remove"
                  onClick={() => onChange(entries.filter((e) => e.key !== entry.key))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() =>
          onChange([...entries, { key: entryKey(), name: "", kind: list.kinds[0] ?? "text", value: "" }])
        }
      >
        <Plus aria-hidden="true" />
        Add {noun}
      </Button>
    </section>
  );
}
