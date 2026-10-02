import { type ConnectionView, connectionType, type OrgView } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageLink } from "@/components/ui/page-link";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Textarea } from "@/components/ui/select";
import { orgLabel } from "@/features/accounts/model";
import { cn } from "@/lib/cn";
import { useConnectionCommand } from "@/lib/connection-queries";
import { describeError, errorDetails } from "@/lib/errors";
import { badgeLetters, formatAgo } from "@/lib/format";
import { ConnectionFields } from "./connection-fields";
import { type ConnectionDraft, connectionStatus, draftOf, updateInput } from "./model";

/** The picked connection: how its last Test went, then its details, its values and what it may change unasked. */
export function ConnectionDetail({
  view,
  orgs,
  testing,
  now,
  onTest,
  onRemoved,
}: {
  view: ConnectionView;
  orgs: readonly OrgView[];
  testing: boolean;
  now: number;
  onTest: () => void;
  onRemoved: () => void;
}) {
  const def = connectionType(view.type);
  const org = orgLabel(view.org, orgs);
  const orgKey = orgs.find((o) => o.id === view.org)?.key;
  const [removing, setRemoving] = useState(false);
  const remove = useConnectionCommand("connections.remove");
  return (
    <DetailPane
      label="Connection details"
      head={
        <div className="flex min-w-0 items-center gap-3">
          <OrgBadge
            label={badgeLetters(orgKey ?? org.name)}
            color={org.color}
            className="size-8 rounded-lg text-xs"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate text-md leading-6 font-semibold">{view.name}</h2>
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
              <span className="shrink-0">{def.label}</span>
              <span aria-hidden="true" className="text-fg-dim">
                ·
              </span>
              <span className="shrink-0">{org.name}</span>
              <span aria-hidden="true" className="text-fg-dim">
                ·
              </span>
              <span className="min-w-0 truncate font-mono text-fg-faint">{view.id}</span>
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={testing}
              onClick={onTest}
              aria-label={`Test ${view.name}`}
            >
              {testing ? "Testing" : "Test"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRemoving(true)}
              aria-label={`Remove ${view.name}`}
            >
              Remove
            </Button>
          </div>
        </div>
      }
    >
      <StatusSection view={view} testing={testing} now={now} />
      <DetailsSection key={`details-${view.id}`} view={view} />
      <ValuesSection key={`values-${view.id}`} view={view} title={`${def.label} settings`} />
      <AllowSection key={`allow-${view.id}`} view={view} />
      {removing && (
        <ConfirmDialog
          title={`Remove ${view.name}?`}
          body={
            <>
              Its secrets and files are deleted.
              {view.agents.length > 0 &&
                ` ${view.agents.length === 1 ? "The agent that uses it loses it" : `The ${view.agents.length} agents that use it lose it`}.`}{" "}
              This cannot be undone.
            </>
          }
          confirmLabel="Remove"
          busy={remove.isPending}
          error={remove.error ? describeError(remove.error) : undefined}
          onCancel={() => setRemoving(false)}
          onConfirm={() =>
            remove.mutate(
              { id: view.id },
              {
                onSuccess: () => {
                  setRemoving(false);
                  onRemoved();
                },
              },
            )
          }
        />
      )}
    </DetailPane>
  );
}

function StatusSection({ view, testing, now }: { view: ConnectionView; testing: boolean; now: number }) {
  const status = connectionStatus(view, testing);
  const test = view.lastTest;
  return (
    <DetailSection title="Status" className="border-t-0">
      <div className="flex min-w-0 flex-col gap-2">
        <span className={cn("flex items-center gap-2 text-base font-medium", LAMP_TEXT[status.lamp])}>
          <Lamp state={status.lamp} size={8} />
          {status.label}
          {test && !testing && (
            <span className="font-normal text-fg-faint">tested {formatAgo(test.at, now)}</span>
          )}
        </span>
        {view.problems.length > 0 && (
          <ul aria-label="Not set up" className="flex flex-col gap-0.5">
            {view.problems.map((p) => (
              <li key={p} className="text-base text-red text-pretty">
                {p}.
              </li>
            ))}
          </ul>
        )}
        {test && !testing && view.problems.length === 0 && (
          <p className={cn("text-base text-pretty", test.ok ? "text-fg-muted" : "text-red")}>{test.detail}</p>
        )}
        {test?.ok &&
          test.warnings.map((w) => (
            <p key={w} className="text-base text-amber text-pretty">
              {w}
            </p>
          ))}
        <p className="text-sm text-fg-faint text-pretty">
          {view.agents.length === 0 ? (
            "No agent of this workspace lists it yet. Root agents get every connection of the task's workspace."
          ) : (
            <>
              Listed by{" "}
              {view.agents.map((id, i) => (
                <span key={id}>
                  {i > 0 && ", "}
                  <PageLink
                    page="agents"
                    search={{ agent: id }}
                    className="rounded-xs font-mono text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                  >
                    @{id}
                  </PageLink>
                </span>
              ))}
              . Root agents get every connection of the task's org.
            </>
          )}
        </p>
      </div>
    </DetailSection>
  );
}

function errorState(error: unknown): SaveState {
  return { kind: "error", message: describeError(error), details: errorDetails(error) };
}

/** Name and description: what agents see of the connection. */
function DetailsSection({ view }: { view: ConnectionView }) {
  const update = useConnectionCommand("connections.update");
  const [name, setName] = useState(view.name);
  const [description, setDescription] = useState(view.description);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const dirty = name.trim() !== view.name || description.trim() !== view.description;
  return (
    <SaveSection
      title="Details"
      note="Agents see the name and description, never a value."
      dirty={dirty}
      state={state}
      onDiscard={() => {
        setName(view.name);
        setDescription(view.description);
        setState({ kind: "idle" });
      }}
      onSave={() => {
        setState({ kind: "saving" });
        update.mutate(
          { id: view.id, name: name.trim(), description: description.trim() },
          { onSuccess: () => setState({ kind: "saved" }), onError: (e) => setState(errorState(e)) },
        );
      }}
    >
      <div className="grid gap-3">
        <Field label="Name">
          {(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field
          label="Description"
          hint="What it reaches and how to use it, like which namespaces matter. Never a secret."
        >
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              maxLength={2000}
              className="font-sans"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
      </div>
    </SaveSection>
  );
}

function plain(draft: ConnectionDraft): string {
  const lists = Object.entries(draft.lists).map(([key, entries]) => [
    key,
    entries.map((e) => [e.name.trim(), e.kind, e.kind === "text" ? e.value.trim() : ""]),
  ]);
  return JSON.stringify([draft.fields, lists]);
}

/** The type's fields and lists. Text saves with the section; secrets and files save on their own. */
function ValuesSection({ view, title }: { view: ConnectionView; title: string }) {
  const update = useConnectionCommand("connections.update");
  const saved = draftOf(view);
  const [draft, setDraft] = useState<ConnectionDraft | undefined>();
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const shown = draft ?? saved;
  const dirty = draft !== undefined && plain(draft) !== plain(saved);
  return (
    <SaveSection
      title={title}
      note="Secrets are never shown again once set."
      dirty={dirty}
      state={state}
      onDiscard={() => {
        setDraft(undefined);
        setState({ kind: "idle" });
      }}
      onSave={() => {
        if (draft === undefined) return;
        setState({ kind: "saving" });
        update.mutate(updateInput(view, draft), {
          onSuccess: () => {
            setDraft(undefined);
            setState({ kind: "saved" });
          },
          onError: (e) => setState(errorState(e)),
        });
      }}
    >
      <ConnectionFields
        type={view.type}
        draft={shown}
        view={view}
        onChange={(next) => {
          setDraft(next);
          setState({ kind: "idle" });
        }}
      />
    </SaveSection>
  );
}

/** The exact writes agents may run without asking. Empty: every write asks the owner. */
function AllowSection({ view }: { view: ConnectionView }) {
  const allow = useConnectionCommand("connections.allow");
  const saved = view.allow.join("\n");
  const [text, setText] = useState(saved);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return (
    <SaveSection
      title="Allowed without asking"
      note="Every other write asks you first."
      dirty={lines.join("\n") !== saved}
      state={state}
      onDiscard={() => {
        setText(saved);
        setState({ kind: "idle" });
      }}
      onSave={() => {
        setState({ kind: "saving" });
        allow.mutate(
          { id: view.id, allow: lines },
          { onSuccess: () => setState({ kind: "saved" }), onError: (e) => setState(errorState(e)) },
        );
      }}
    >
      <Field
        label="Actions, one per line"
        hint="Exact actions, like kubectl rollout restart deployment/api. Reads never ask."
      >
        {(p) => (
          <Textarea
            {...p}
            rows={Math.max(2, Math.min(8, lines.length + 1))}
            value={text}
            placeholder="kubectl rollout restart deployment/api"
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </Field>
    </SaveSection>
  );
}
