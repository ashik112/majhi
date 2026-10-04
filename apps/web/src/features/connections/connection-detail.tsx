import {
  type ConnectionView,
  connectionType,
  GLOBAL_CONNECTIONS,
  type OrgView,
  type ServiceProduct,
  serviceByUrl,
} from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { PageLink } from "@/components/ui/page-link";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Textarea } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useConnectionCommand } from "@/lib/connection-queries";
import { describeError, errorDetails } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useAgents } from "@/lib/studio-queries";
import { ConnectSection, isOauth } from "./connect-section";
import { ConnectionFields } from "./connection-fields";
import { type ConnectionDraft, connectionStatus, draftOf, updateInput } from "./model";
import { ProductPicker } from "./product-picker";
import { scopeName, WorkspaceTag } from "./scope-picker";
import { ServiceLogo, serviceOf } from "./service-logo";

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
  const service = serviceByUrl(view.fields.url?.value ?? "");
  const [removing, setRemoving] = useState(false);
  const remove = useConnectionCommand("connections.remove");
  return (
    <DetailPane
      label="Connection details"
      head={
        <div className="flex min-w-0 items-center gap-3">
          <ServiceLogo service={serviceOf(view)} type={view.type} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate text-md leading-6 font-semibold">{view.name}</h2>
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
              <WorkspaceTag org={view.org} orgs={orgs} className="font-medium text-fg-soft" />
              <span aria-hidden="true" className="text-fg-dim">
                ·
              </span>
              <span className="shrink-0">
                {view.org === GLOBAL_CONNECTIONS ? "Shared with every workspace" : def.label}
              </span>
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
      {isOauth(view) && <ConnectSection view={view} now={now} />}
      <StatusSection view={view} testing={testing} now={now} />
      {service?.products !== undefined && (
        <ProductsSection key={`products-${view.id}`} view={view} products={service.products} />
      )}
      <AgentsSection view={view} orgs={orgs} />
      <DetailsSection key={`details-${view.id}`} view={view} />
      {!isOauth(view) && (
        <ValuesSection key={`values-${view.id}`} view={view} title={`${def.label} settings`} />
      )}
      <AllowSection key={`allow-${view.id}`} view={view} />
      {removing && (
        <ConfirmDialog
          title={`Remove ${view.name}?`}
          body={
            <>
              Its secrets and files are deleted.
              {view.org === GLOBAL_CONNECTIONS
                ? " Agents in every workspace lose access to this connection."
                : view.agents.length > 0 &&
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
    <DetailSection title="Status" className={isOauth(view) ? "" : "border-t-0"}>
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
      </div>
    </DetailSection>
  );
}

/** Which agents get it: every agent of its workspace and every root agent, each with a switch. */
function AgentsSection({ view, orgs }: { view: ConnectionView; orgs: readonly OrgView[] }) {
  const agents = useAgents();
  const update = useConnectionCommand("connections.update");
  const toast = useToast();
  const global = view.org === GLOBAL_CONNECTIONS;
  const candidates = (agents.data ?? []).flatMap((e) =>
    e.status === "ok" &&
    (global || e.agent.frontmatter.scope === view.org || e.agent.frontmatter.scope === "root")
      ? [e.agent.frontmatter]
      : [],
  );
  const root = candidates.filter((a) => a.scope === "root");
  const own = candidates.filter((a) => a.scope !== "root");
  const toggle = (agent: string, on: boolean) =>
    update.mutate(
      {
        id: view.id,
        agentsOff: on ? view.agentsOff.filter((a) => a !== agent) : [...view.agentsOff, agent],
      },
      {
        onError: (error) =>
          toast(`Could not change @${agent}`, { detail: describeError(error), tone: "error" }),
      },
    );
  const row = (a: (typeof candidates)[number]) => (
    <li key={a.id} className="flex min-w-0 items-center gap-3">
      <Switch
        label={`@${a.id}`}
        checked={!view.agentsOff.includes(a.id)}
        disabled={update.isPending}
        onChange={(on) => toggle(a.id, on)}
      />
      <span className="truncate text-sm text-fg-faint">
        {a.role}
        {global && a.scope !== "root" ? ` · ${scopeName(a.scope, orgs)}` : ""}
      </span>
    </li>
  );
  return (
    <DetailSection
      title="Agents"
      note={
        global
          ? "Every agent gets it, in every workspace. Switch one off to keep it from that agent."
          : `Every agent of ${scopeName(view.org, orgs)} gets it, and root agents in its tasks. Switch one off to keep it from that agent.`
      }
    >
      {agents.isError ? (
        <p role="alert" className="text-sm text-red">
          Could not load agents: {describeError(agents.error)}
        </p>
      ) : candidates.length === 0 && agents.data !== undefined ? (
        <p className="text-sm text-amber text-pretty">
          {scopeName(view.org, orgs)} has no agents yet, so nothing uses this connection.{" "}
          <PageLink page="agents" className="text-fg underline-offset-2 hover:underline">
            Add an agent
          </PageLink>
          .
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {own.length > 0 && (
            <ul aria-label="Workspace agents" className="flex flex-col gap-0.5">
              {own.map(row)}
            </ul>
          )}
          {root.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-fg-muted">Root agents</p>
              <ul aria-label="Root agents" className="flex flex-col gap-0.5">
                {root.map(row)}
              </ul>
            </div>
          )}
        </div>
      )}
    </DetailSection>
  );
}

/** The products of a service that has them. A change reaches sessions at their next turn. */
function ProductsSection({ view, products }: { view: ConnectionView; products: readonly ServiceProduct[] }) {
  const update = useConnectionCommand("connections.update");
  const saved = (view.fields.products?.value ?? "").split(/\s+/).filter((p) => p !== "");
  const [draft, setDraft] = useState<string[]>();
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const shown = draft ?? saved;
  return (
    <SaveSection
      title="Products"
      note="Each product is its own MCP server on the same sign-in."
      dirty={draft !== undefined && draft.join(" ") !== saved.join(" ")}
      state={state}
      onDiscard={() => {
        setDraft(undefined);
        setState({ kind: "idle" });
      }}
      onSave={() => {
        if (draft === undefined) return;
        setState({ kind: "saving" });
        update.mutate(
          { id: view.id, fields: { products: draft.join(" ") } },
          {
            onSuccess: () => {
              setDraft(undefined);
              setState({ kind: "saved" });
            },
            onError: (e) => setState(errorState(e)),
          },
        );
      }}
    >
      <ProductPicker
        compact
        products={products}
        value={shown}
        onChange={(next) => {
          setDraft(next);
          setState({ kind: "idle" });
        }}
      />
    </SaveSection>
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
