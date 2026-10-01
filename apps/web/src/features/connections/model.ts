import {
  CONNECTION_LISTS,
  type CommandInput,
  type ConnectionListKey,
  type ConnectionType,
  type ConnectionView,
  connectionType,
  type FieldKind,
  HeaderNameSchema,
  reservedVariable,
  VariableNameSchema,
} from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";

/** A connection's lamp and word: testing now, not set up, or how its last Test went. */
export function connectionStatus(
  view: Pick<ConnectionView, "problems" | "lastTest">,
  testing: boolean,
): { lamp: LampState; label: string } {
  if (testing) return { lamp: "working", label: "Testing" };
  if (view.problems.length > 0) return { lamp: "needs", label: "Not set up" };
  const test = view.lastTest;
  if (test === undefined) return { lamp: "idle", label: "Not tested" };
  if (!test.ok) return { lamp: "needs", label: "Failed" };
  return { lamp: "done", label: test.warnings.length > 0 ? "Works, with a warning" : "Works" };
}

export const KIND_LABEL: Record<FieldKind, string> = { secret: "Secret", text: "Text", file: "File" };

/** One entry of a list while the owner edits it. */
export interface DraftEntry {
  /** Stays the same while the name is typed, for React. */
  key: string;
  name: string;
  kind: FieldKind;
  /** A text entry's value. */
  value: string;
}

/** The text fields and the lists of one connection, as the form edits them. */
export interface ConnectionDraft {
  fields: Record<string, string>;
  lists: Record<ConnectionListKey, DraftEntry[]>;
}

let nextKey = 0;
export function entryKey(): string {
  nextKey += 1;
  return `entry-${nextKey}`;
}

/** An empty draft for a new connection of this type: choice fields start at their default. */
export function emptyDraft(type: ConnectionType): ConnectionDraft {
  const fields: Record<string, string> = {};
  for (const f of connectionType(type).fields) {
    if (f.kind === "text") fields[f.key] = f.choices?.[0]?.value ?? "";
  }
  return { fields, lists: { vars: [], headers: [], env: [] } };
}

export function draftOf(view: ConnectionView): ConnectionDraft {
  const draft = emptyDraft(view.type);
  for (const key of Object.keys(draft.fields)) {
    const value = view.fields[key]?.value;
    if (value !== undefined) draft.fields[key] = value;
  }
  for (const key of CONNECTION_LISTS) {
    draft.lists[key] = Object.entries(view[key]).map(([name, v]) => ({
      key: `${key}:${name}`,
      name,
      kind: v.kind,
      value: v.value ?? "",
    }));
  }
  return draft;
}

/** The text values that are filled in: what decides which fields and lists count. */
export function filledFields(draft: ConnectionDraft): Record<string, string> {
  return Object.fromEntries(Object.entries(draft.fields).filter(([, v]) => v.trim() !== ""));
}

/** Why an entry's name does not work, or undefined. */
export function entryNameProblem(
  names: "variable" | "header",
  entry: DraftEntry,
  all: readonly DraftEntry[],
): string | undefined {
  const name = entry.name.trim();
  if (name === "") return "Give it a name";
  const schema = names === "header" ? HeaderNameSchema : VariableNameSchema;
  const parsed = schema.safeParse(name);
  if (!parsed.success) return parsed.error.issues[0]?.message;
  if (names === "variable" && reservedVariable(name)) return `${name} is kept for majhi and the agent CLIs`;
  const same = (other: DraftEntry) =>
    names === "header" ? other.name.trim().toLowerCase() === name.toLowerCase() : other.name.trim() === name;
  if (all.some((other) => other.key !== entry.key && same(other))) return `${name} is there twice`;
  return undefined;
}

function entriesInput(entries: readonly DraftEntry[]) {
  return Object.fromEntries(
    entries.map((e) => {
      const value = e.value.trim();
      return [e.name.trim(), e.kind === "text" && value !== "" ? { kind: e.kind, value } : { kind: e.kind }];
    }),
  );
}

function sameEntries(view: ConnectionView, key: ConnectionListKey, entries: readonly DraftEntry[]): boolean {
  const before = Object.entries(view[key]).map(([name, v]) => [name, v.kind, v.value ?? ""].join("\u0000"));
  const after = entries.map((e) =>
    [e.name.trim(), e.kind, e.kind === "text" ? e.value.trim() : ""].join("\u0000"),
  );
  return JSON.stringify(before) === JSON.stringify(after);
}

/** The update for what the draft changed: text values (empty clears one) and each list that changed. */
export function updateInput(
  view: ConnectionView,
  draft: ConnectionDraft,
): CommandInput<"connections.update"> {
  const def = connectionType(view.type);
  const input: CommandInput<"connections.update"> = { id: view.id };
  const fields: Record<string, string | null> = {};
  for (const field of def.fields) {
    if (field.kind !== "text") continue;
    const next = (draft.fields[field.key] ?? "").trim();
    if (next === (view.fields[field.key]?.value ?? "")) continue;
    fields[field.key] = next === "" ? null : next;
  }
  if (Object.keys(fields).length > 0) input.fields = fields;
  for (const list of def.lists) {
    const entries = draft.lists[list.key];
    if (!sameEntries(view, list.key, entries)) input[list.key] = entriesInput(entries);
  }
  return input;
}

/** The create input: the text values that are filled in and the entries of the lists that count. */
export function createInput(input: {
  org: string;
  type: ConnectionType;
  name: string;
  description: string;
  draft: ConnectionDraft;
  lists: readonly ConnectionListKey[];
}): CommandInput<"connections.create"> {
  const out: CommandInput<"connections.create"> = {
    org: input.org,
    type: input.type,
    name: input.name.trim(),
  };
  if (input.description.trim() !== "") out.description = input.description.trim();
  const fields = filledFields(input.draft);
  if (Object.keys(fields).length > 0)
    out.fields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.trim()]));
  for (const key of input.lists) {
    const entries = input.draft.lists[key];
    if (entries.length > 0) out[key] = entriesInput(entries);
  }
  return out;
}

/** The connections of one org, in the orgs' order; every org shows, so each offers its add button. */
export function connectionGroups(
  connections: readonly ConnectionView[],
  orgs: readonly { id: string }[],
  filter: string | undefined,
): { org: string; items: ConnectionView[] }[] {
  return orgs
    .filter((o) => filter === undefined || o.id === filter)
    .map((o) => ({ org: o.id, items: connections.filter((c) => c.org === o.id) }));
}
